import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAuthorizeUrl, defaultDiscordSettings, diffMappedRoles, discordConfig,
  exchangeCode, featureSwitches, fetchGuildRoles, fetchIdentity,
  permissionsForRoles, sanitizeDiscordSettings, sendChannelMessage, startBot, stopBot
} from "./discord.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const seedDir = path.join(__dirname, "data");
const dataDir = process.env.DATA_DIR || seedDir;
const rosterPath = path.join(dataDir, "roster.json");
const usersPath = path.join(dataDir, "users.json");
const applicationsPath = path.join(dataDir, "applications.json");
const onboardingPath = path.join(dataDir, "onboarding.json");
const bugsPath = path.join(dataDir, "bugs.json");
// Ranks deliberately live in their own file rather than inside roster.json:
// syncSeedImport() replaces the whole live roster with the sheet-derived seed
// whenever a newer import ships, which would silently wipe any rank Command
// added through the Rank Manager. Nothing in the import path touches this file.
const ranksPath = path.join(dataDir, "ranks.json");
// Role-to-permission mapping only. Deliberately contains no credentials —
// every Discord secret is read from the environment (see discord.js).
const discordPath = path.join(dataDir, "discord.json");
const port = Number(process.env.PORT || 3000);
const sessions = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

// Legacy (pre-hashing) accounts still store a plain password string — fall
// back to a direct compare for those so existing logins don't break, and let
// the login handler upgrade them to a hash on next successful sign-in.
function verifyPassword(password, stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return stored === password;
  }
  const [, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isHashedPassword(stored) {
  const parts = String(stored || "").split(":");
  return parts.length === 3 && parts[0] === "scrypt";
}

// Returns the roster entry already holding this callsign if it's occupied by
// someone else, or null if the callsign is free to assign (vacant or unused).
function occupiedCallsignConflict(rosterEntries, callsign, excludeId = null) {
  const trimmed = String(callsign || "").trim();
  if (!trimmed) return null;
  const match = rosterEntries.find(
    (e) => e.id !== excludeId && String(e.callsign || "").trim() === trimmed
  );
  if (!match) return null;
  return !match.vacant && match.activity !== "Vacant" && match.name ? match : null;
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

const ROSTER_AUDIT_LIMIT = 500;
// Fields worth reporting a before/after for. Deliberately excludes
// employeeNotes so the audit trail doesn't become a second copy of private
// notes for anyone who can read the log.
const ROSTER_AUDIT_FIELDS = [
  "callsign", "name", "rank", "activity", "promotionDate", "tig", "clearedForPatrol"
];

function rosterDiff(before = {}, after = {}) {
  const changes = [];
  for (const field of ROSTER_AUDIT_FIELDS) {
    const from = before[field] ?? "";
    const to = after[field] ?? "";
    if (String(from) !== String(to)) changes.push({ field, from: String(from), to: String(to) });
  }
  for (const group of ["divisions", "strikes"]) {
    const keys = new Set([...Object.keys(before[group] || {}), ...Object.keys(after[group] || {})]);
    for (const key of keys) {
      const from = Boolean(before[group]?.[key]);
      const to = Boolean(after[group]?.[key]);
      if (from !== to) changes.push({ field: `${group}.${key}`, from: String(from), to: String(to) });
    }
  }
  return changes;
}

// Appends to the roster's own audit trail. Kept inside roster.json (rather
// than a new file) so it rides the same write lock as the change it records
// and can never disagree with it — but stripped from the public GET.
function recordRosterAudit(rosterData, actor, action, entry, changes = []) {
  const log = Array.isArray(rosterData.auditLog) ? rosterData.auditLog : [];
  log.unshift({
    at: new Date().toISOString(),
    by: actor?.email || "system",
    byName: actor?.name || "",
    action,
    entryId: entry?.id || "",
    callsign: entry?.callsign || "",
    name: entry?.name || "",
    changes
  });
  rosterData.auditLog = log.slice(0, ROSTER_AUDIT_LIMIT);
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers
  });
  res.end(body);
}

function cookieValue(req, name) {
  const cookie = req.headers.cookie || "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.split("=")[1];
}

const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3MB — generous for any form, with headroom for typing-replay snapshots

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Matches the pd_session cookie's Max-Age (8h). The cookie stops being sent
// by the browser after this, but nothing previously enforced it server-side —
// a copied/replayed token would otherwise stay valid forever.
const SESSION_MAX_AGE_MS = 8 * 3600 * 1000;

function isSessionExpired(session) {
  return Date.now() - session.createdAt > SESSION_MAX_AGE_MS;
}

async function currentUser(req) {
  const token = cookieValue(req, "pd_session");
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  if (isSessionExpired(session)) {
    sessions.delete(token);
    return null;
  }
  const { users } = await readJson(usersPath);
  return users.find((user) => user.id === session.userId) || null;
}

// Admins hold every permission regardless of what their record stores. This
// used to be applied only in publicUser(), so the dashboard showed an admin
// full controls while requireEdit/requireManageUsers read the raw (unchecked)
// flags and answered 403 — permissions had to agree in both places.
function effectivePermissions(user) {
  if (!user) return null;
  if (user.role !== "admin") return user;
  return {
    ...user,
    canEditRoster: true,
    canManageUsers: true,
    canOnboard: true,
    canManageRanks: true
  };
}

function publicUser(user) {
  if (!user) return null;
  const { password, ...safe } = effectivePermissions(user);
  return safe;
}

function requireUser(user, res) {
  if (!user) {
    send(res, 401, { error: "Sign in required." });
    return false;
  }
  return true;
}

function requireEdit(user, res) {
  if (!requireUser(user, res)) return false;
  if (!effectivePermissions(user).canEditRoster) {
    send(res, 403, { error: "You do not have roster edit permission." });
    return false;
  }
  return true;
}

function requireManageUsers(user, res) {
  if (!requireUser(user, res)) return false;
  if (!effectivePermissions(user).canManageUsers) {
    send(res, 403, { error: "Admin user management permission required." });
    return false;
  }
  return true;
}

function requireManageRanks(user, res) {
  if (!requireUser(user, res)) return false;
  if (!effectivePermissions(user).canManageRanks) {
    send(res, 403, { error: "Rank management permission required." });
    return false;
  }
  return true;
}

// Authority ladder for the Users panel. You may only delete, or change the
// permissions of, an account strictly below your own level — so Command can
// clean up officers and onboarding staff but cannot touch an admin, cannot
// touch a fellow Command account, and cannot promote themselves. Enforced
// here rather than only in the UI, since the UI is just a suggestion.
const ROLE_AUTHORITY = { admin: 3, command: 2, supervisor: 1, onboarding: 1, viewer: 0 };

function authorityOf(user) {
  if (!user) return -1;
  if (user.role === "admin") return ROLE_AUTHORITY.admin;
  const base = ROLE_AUTHORITY[String(user.role || "viewer")] ?? 0;
  // A viewer-role account holding manage-users still outranks plain viewers,
  // otherwise a hand-edited record could end up unable to manage anyone.
  return user.canManageUsers ? Math.max(base, ROLE_AUTHORITY.command) : base;
}

// Returns an error string when `actor` may not act on `target`, else null.
// Editing your own account is allowed (password, display name) — what's
// blocked is changing your own role or permission flags, checked separately
// by samePermissions() so nobody can promote themselves.
function targetOutOfReach(actor, target, { allowSelf = false } = {}) {
  if (actor.id === target.id) {
    return allowSelf ? null : "You cannot do this to your own account.";
  }
  if (authorityOf(target) >= authorityOf(actor)) {
    return "You cannot modify an account at or above your own permission level.";
  }
  return null;
}

const PERMISSION_FIELDS = ["role", "canEditRoster", "canManageUsers", "canOnboard", "canManageRanks"];

function samePermissions(a, b) {
  return PERMISSION_FIELDS.every((field) => String(a?.[field] ?? "") === String(b?.[field] ?? ""));
}

// Who may read/act on applications — the same rule the application routes
// were each repeating inline.
function canReviewApplications(user) {
  const perms = effectivePermissions(user);
  return Boolean(perms && (perms.canEditRoster || perms.canOnboard));
}

function requireReviewApplications(user, res) {
  // 401 when signed out, 403 when signed in without the permission — an
  // expired or revoked session used to read as "Forbidden", which tells the
  // user their account lacks access rather than that they need to sign in.
  if (!requireUser(user, res)) return false;
  if (!canReviewApplications(user)) {
    send(res, 403, { error: "You do not have permission to review applications." });
    return false;
  }
  return true;
}

// Bug reports are visible to anyone who can act on them — roster editors and
// user managers alike.
function requireManageBugs(user, res) {
  if (!requireUser(user, res)) return false;
  const perms = effectivePermissions(user);
  if (!perms.canEditRoster && !perms.canManageUsers) {
    send(res, 403, { error: "Forbidden" });
    return false;
  }
  return true;
}

function requireOnboard(user, res) {
  if (!requireUser(user, res)) return false;
  if (!effectivePermissions(user).canOnboard) {
    send(res, 403, { error: "Onboarding permission required." });
    return false;
  }
  return true;
}

function sanitizeRosterEntry(input, existing = {}) {
  const divisions = input.divisions || {};
  const strikes = input.strikes || {};
  const divisionKeys = Object.keys({ ...(existing.divisions || {}), ...divisions });
  const strikeKeys = Object.keys({ ...(existing.strikes || {}), ...strikes });
  const name = String(input.name || "").trim();
  const activity = String(input.activity || "").trim();
  return {
    id: existing.id || crypto.randomUUID(),
    callsign: String(input.callsign || "").trim(),
    name,
    activity,
    rank: String(input.rank || "").trim(),
    divisions: Object.fromEntries(divisionKeys.map((key) => [key, Boolean(divisions[key])])),
    strikes: Object.fromEntries(strikeKeys.map((key) => [key, Boolean(strikes[key])])),
    notes: String(input.notes || "").trim(),
    employeeNotes: String(input.employeeNotes || "").trim(),
    promotionDate: String(input.promotionDate || "").trim(),
    tig: String(input.tig || "").trim(),
    // Derived from activity/name rather than trusted from the "Vacant slot"
    // checkbox directly — a filled-in name with a stale checked box used to
    // save fine but stay hidden everywhere "vacant" is checked.
    vacant: activity === "Vacant" || !name,
    clearedForPatrol: Boolean(input.clearedForPatrol ?? existing.clearedForPatrol)
  };
}

function sanitizeUser(input, existing = {}) {
  const email = String(input.email || existing.email || "").trim().toLowerCase();
  const nextPassword = String(input.password || "").trim()
    ? hashPassword(String(input.password).trim())
    : existing.password || hashPassword("changeme");
  return {
    id: existing.id || crypto.randomUUID(),
    name: String(input.name || existing.name || "").trim(),
    email,
    password: nextPassword,
    role: String(input.role || existing.role || "viewer").trim(),
    canEditRoster: Boolean(input.canEditRoster),
    canManageUsers: Boolean(input.canManageUsers),
    canOnboard: Boolean(input.canOnboard),
    canManageRanks: Boolean(input.canManageRanks),
    discord: sanitizeDiscordLink(input.discord ?? existing.discord)
  };
}

// Discord identity attached to an account by OAuth linking. Stored on the user
// record; never includes a token — see discord.js for why credentials stay in
// the environment only.
function sanitizeDiscordLink(input) {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id || "").trim();
  if (!/^\d{5,25}$/.test(id)) return null;
  return {
    id,
    username: String(input.username || "").trim().slice(0, 64),
    globalName: String(input.globalName || "").trim().slice(0, 64),
    roleIds: Array.isArray(input.roleIds)
      ? input.roleIds.map((r) => String(r).trim()).filter((r) => /^\d{5,25}$/.test(r)).slice(0, 100)
      : [],
    linkedAt: String(input.linkedAt || new Date().toISOString()),
    syncedAt: input.syncedAt ? String(input.syncedAt) : null
  };
}

// In-memory, like sessions — a pending OAuth handshake is worthless after a
// restart and shouldn't outlive one.
const oauthStates = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

async function readDiscordSettings() {
  try {
    const data = await readJson(discordPath);
    return { ...defaultDiscordSettings(), ...data, ...sanitizeDiscordSettings(data) };
  } catch {
    return defaultDiscordSettings();
  }
}

// Applies mapped Discord roles to a user record in place. Never touches
// `role`, so a Discord role can grant permissions but can never mint a site
// admin — that stays a deliberate human action.
async function applyDiscordPermissions(userRecord, roleIds) {
  if (!featureSwitches().permissionSync) return false;
  const settings = await readDiscordSettings();
  const { matched, permissions } = permissionsForRoles(roleIds, settings);
  if (!matched) return false;
  Object.assign(userRecord, permissions);
  return true;
}

// The rank list is a flat, ordered array — highest authority first. Order is
// the promotion path; `category` is only the grouping label the public roster
// renders cards for, so a category's ranks don't have to be contiguous (Lead
// Detective sits between Sergeant and Corporal while sharing the Detective
// Bureau card with the ranks below Corporal).
function normalizeRankName(rank) {
  return String(rank || "").replace(/\s+/g, " ").trim();
}

function sanitizeRankList(input) {
  const seen = new Set();
  const ranks = [];
  for (const raw of Array.isArray(input) ? input.slice(0, 100) : []) {
    const name = normalizeRankName(typeof raw === "string" ? raw : raw?.name).slice(0, 60);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ranks.push({
      name,
      category: normalizeRankName(raw?.category).slice(0, 60) || "Other",
      aliases: Array.isArray(raw?.aliases)
        ? [...new Set(raw.aliases.map((a) => normalizeRankName(a).slice(0, 60)).filter(Boolean))].slice(0, 20)
        : []
    });
  }
  return ranks;
}

async function readRanks() {
  try {
    const data = await readJson(ranksPath);
    const ranks = sanitizeRankList(data.ranks);
    if (ranks.length) return { ...data, ranks };
  } catch {
    // fall through to the seed below
  }
  return { ranks: sanitizeRankList(JSON.parse(await fs.readFile(path.join(seedDir, "ranks.json"), "utf8")).ranks) };
}

// A rank a roster entry still uses can't be deleted out from under it, or the
// entry drops into the "Other" bucket and stops appearing under any category
// card on the public roster.
function ranksInUse(rosterEntries) {
  const used = new Map();
  for (const entry of rosterEntries) {
    const name = normalizeRankName(entry.rank);
    if (!name) continue;
    used.set(name.toLowerCase(), (used.get(name.toLowerCase()) || 0) + 1);
  }
  return used;
}

// The recruit pipeline, in order. Served with the board so the frontend can't
// drift out of sync, and validated on every move.
const ONBOARDING_STAGES = [
  "Application Pending",
  "Application Accepted",
  "Interview Accepted",
  "Academy Scheduled",
  "Academy Passed",
  "Ride Alongs Completed",
  "Cleared For Patrol"
];

// Stages that place someone in a callsign, and the rank that comes with it.
// Reaching one of these needs a roster write, which is why they're queued for
// approval when the person moving the card can't edit the roster.
const CALLSIGN_STAGES = {
  "Interview Accepted": "Recruit",
  "Academy Passed": "Probationary Officer"
};

// Puts a pipeline card's person into a callsign, filling a vacant slot, moving
// their existing entry, or creating one — whichever applies. Mutates `card`
// and writes the roster. Returns an error string, or null on success; nothing
// is written when it returns an error.
async function assignCallsignToCard(card, { callsign, rank, user }) {
  const trimmed = String(callsign || "").trim();
  if (!trimmed) return "A callsign is required.";
  const newRank = normalizeRankName(rank);
  if (!newRank) return "A rank is required.";

  const roster = await readJson(rosterPath);
  // One conflict check covering all three paths below, excluding whatever
  // entry this person already holds.
  const conflict = occupiedCallsignConflict(roster.roster, trimmed, card.rosterId || null);
  if (conflict) return `Callsign ${trimmed} is already assigned to ${conflict.name}.`;

  const vacantIdx = roster.roster.findIndex(
    (entry) => (entry.vacant || entry.activity === "Vacant") &&
               String(entry.callsign || "").trim() === trimmed
  );
  const today = new Date().toISOString().split("T")[0];

  if (vacantIdx !== -1) {
    const before = { ...roster.roster[vacantIdx] };
    Object.assign(roster.roster[vacantIdx], {
      name: card.name,
      rank: newRank,
      activity: "Active",
      vacant: false,
      notes: card.discord || "",
      promotionDate: today,
      updatedAt: new Date().toISOString()
    });
    recordRosterAudit(roster, user, `assigned ${trimmed} (${newRank})`,
      roster.roster[vacantIdx], rosterDiff(before, roster.roster[vacantIdx]));

    // Vacate whatever slot they held before, so the old callsign reopens.
    if (card.rosterId && card.rosterId !== roster.roster[vacantIdx].id) {
      const oldIdx = roster.roster.findIndex((entry) => entry.id === card.rosterId);
      if (oldIdx !== -1) {
        recordRosterAudit(roster, user, "vacated (moved slot)", roster.roster[oldIdx], [
          { field: "name", from: String(roster.roster[oldIdx].name || ""), to: "" }
        ]);
        Object.assign(roster.roster[oldIdx], {
          name: "", activity: "Vacant", vacant: true, notes: "",
          employeeNotes: "", clearedForPatrol: false, promotionDate: "",
          updatedAt: new Date().toISOString()
        });
      }
    }
    card.rosterId = roster.roster[vacantIdx].id;
  } else if (card.rosterId) {
    const rIdx = roster.roster.findIndex((entry) => entry.id === card.rosterId);
    if (rIdx === -1) return "This recruit's roster entry no longer exists.";
    const before = { ...roster.roster[rIdx] };
    Object.assign(roster.roster[rIdx], {
      rank: newRank,
      callsign: trimmed,
      activity: "Active",
      vacant: false,
      updatedAt: new Date().toISOString()
    });
    recordRosterAudit(roster, user, `assigned ${trimmed} (${newRank})`,
      roster.roster[rIdx], rosterDiff(before, roster.roster[rIdx]));
  } else {
    // No vacant slot with that callsign and no entry yet — this is a recruit
    // joining the roster for the first time.
    const entry = sanitizeRosterEntry({
      callsign: trimmed,
      name: card.name,
      rank: newRank,
      activity: "Active",
      notes: card.discord || "",
      promotionDate: today
    });
    roster.roster.push(entry);
    card.rosterId = entry.id;
    recordRosterAudit(roster, user, `assigned ${trimmed} (${newRank}, new entry)`, entry, rosterDiff({}, entry));
  }

  card.callsign = trimmed;
  card.rank = newRank;
  card.pendingCallsign = null;
  roster.updatedAt = new Date().toISOString();
  roster.updatedBy = user.email;
  await writeJson(rosterPath, roster);
  return null;
}

const KNOWN_APPLICATION_FIELDS = ["roleplayPhilosophy", "characterDescription", "leoExperience", "bannedHistory", "clips"];
const MAX_TYPING_SNAPSHOTS = 120;
const MAX_TYPING_VALUE_LENGTH = 20000;
const MAX_TYPING_CHUNK_LENGTH = 5000;
const MAX_PASTE_SAMPLES = 10;
const MAX_PASTE_SAMPLE_LENGTH = 200;
// A chunk of text this large appearing between two snapshots is beyond
// human typing speed for the interval, so it was pasted or scripted —
// caught even when the paste event itself didn't fire.
const BURST_CHARS_THRESHOLD = 120;

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// Snapshots arrive delta-encoded as {t, k, s}: k = how many leading chars are
// shared with the previous value, s = everything after that. Typing mostly
// appends, so a whole replay costs about one copy of the essay instead of a
// full copy of the text at every single step.
function sanitizeTypingReplay(input) {
  if (!input || typeof input !== "object") return {};
  const result = {};
  for (const field of KNOWN_APPLICATION_FIELDS) {
    const snapshots = input[field];
    if (!Array.isArray(snapshots)) continue;
    // Legacy {t, v} snapshots (pre delta-encoding) are converted rather than
    // clamped to empty, so re-saving an old application doesn't wipe its replay.
    let previous = "";
    const cleaned = snapshots.slice(0, MAX_TYPING_SNAPSHOTS).map((snap) => {
      const legacy = typeof snap?.k !== "number" || typeof snap?.s !== "string";
      if (legacy) {
        const value = String(snap?.v ?? "").slice(0, MAX_TYPING_VALUE_LENGTH);
        let shared = 0;
        while (shared < previous.length && shared < value.length && previous[shared] === value[shared]) shared += 1;
        previous = value;
        return {
          t: clampInt(snap?.t, 0, 86400000),
          k: shared,
          s: value.slice(shared, shared + MAX_TYPING_CHUNK_LENGTH)
        };
      }
      const k = clampInt(snap.k, 0, MAX_TYPING_VALUE_LENGTH);
      const s = snap.s.slice(0, MAX_TYPING_CHUNK_LENGTH);
      previous = previous.slice(0, Math.min(k, previous.length)) + s;
      return { t: clampInt(snap?.t, 0, 86400000), k, s };
    });
    if (cleaned.length) result[field] = cleaned;
  }
  return result;
}

// Rebuilds the full text at each step from the deltas. Applications submitted
// before delta encoding shipped stored the whole value as {t, v} instead of
// {t, k, s}; those decoded to the literal string "undefined" (k undefined ->
// slice(0, NaN) -> "", plus an undefined chunk), so replay for every older
// application rendered as "undefined". Fall back to the full value when a
// snapshot has no delta fields.
function decodeTypingSnapshots(snapshots) {
  const values = [];
  let prev = "";
  for (const snap of snapshots) {
    if (typeof snap?.k !== "number" || typeof snap?.s !== "string") {
      prev = String(snap?.v ?? prev);
    } else {
      prev = prev.slice(0, Math.min(snap.k, prev.length)) + snap.s;
    }
    values.push({ t: Number(snap?.t) || 0, v: prev });
  }
  return values;
}

// Derived from the replay once at submission time, so reviewers get these
// signals without the dashboard having to download every applicant's full
// replay just to render the summary.
function computeTypingStats(replay) {
  const stats = {};
  for (const [field, snapshots] of Object.entries(replay)) {
    const values = decodeTypingSnapshots(snapshots);
    if (values.length < 2) continue;
    let revisions = 0;
    let maxJumpChars = 0;
    let maxJumpMs = 0;
    for (let i = 1; i < values.length; i += 1) {
      const prev = values[i - 1].v;
      const current = values[i].v;
      // Anything that isn't a pure append means text was edited or deleted —
      // i.e. evidence of actual composition rather than transcription.
      if (!current.startsWith(prev)) revisions += 1;
      const added = current.length - prev.length;
      if (added > maxJumpChars) {
        maxJumpChars = added;
        maxJumpMs = Math.max(1, values[i].t - values[i - 1].t);
      }
    }
    stats[field] = {
      revisions,
      maxJumpChars,
      maxJumpCps: maxJumpMs ? Math.round((maxJumpChars / maxJumpMs) * 1000) : 0,
      finalLength: values[values.length - 1].v.length,
      snapshots: values.length
    };
  }
  return stats;
}

// The first N characters of whatever was pasted, so a reviewer can tell a
// pasted Discord link from three pasted paragraphs.
function sanitizePasteSamples(input) {
  if (!input || typeof input !== "object") return {};
  const result = {};
  for (const field of KNOWN_APPLICATION_FIELDS) {
    const samples = input[field];
    if (!Array.isArray(samples)) continue;
    const cleaned = samples
      .slice(0, MAX_PASTE_SAMPLES)
      .map((sample) => String(sample ?? "").slice(0, MAX_PASTE_SAMPLE_LENGTH))
      .filter(Boolean);
    if (cleaned.length) result[field] = cleaned;
  }
  return result;
}

function sanitizeApplication(input, existing = {}) {
  return {
    id: existing.id || crypto.randomUUID(),
    name: String(input.name || existing.name || "").trim(),
    discord: String(input.discord || existing.discord || "").trim(),
    age: String(input.age || existing.age || "").trim(),
    factionCharacter: String(input.factionCharacter || existing.factionCharacter || "").trim(),
    roleplayPhilosophy: String(input.roleplayPhilosophy || existing.roleplayPhilosophy || "").trim(),
    characterDescription: String(input.characterDescription || existing.characterDescription || "").trim(),
    leoExperience: String(input.leoExperience || existing.leoExperience || "").trim(),
    bannedHistory: String(input.bannedHistory || existing.bannedHistory || "").trim(),
    clips: String(input.clips || existing.clips || "").trim(),
    status: String(input.status || existing.status || "pending").trim(),
    submittedAt: existing.submittedAt || new Date().toISOString(),
    reviewedAt: input.reviewedAt || existing.reviewedAt || "",
    reviewedBy: input.reviewedBy || existing.reviewedBy || "",
    rosterEntryId: input.rosterEntryId || existing.rosterEntryId || "",
    // Review signals for staff, not the applicant — pastedFields/pasteSamples/
    // away*/duration/typingReplay come from the client at submission time
    // (best-effort, informational only). similarityFlags and typingStats are
    // computed server-side in the submit handler, and notes/auditLog/archived
    // are managed by their own endpoints — all of those are never trusted from
    // client input here, only carried forward via `existing`.
    pastedFields: Array.isArray(input.pastedFields)
      ? input.pastedFields.filter((f) => KNOWN_APPLICATION_FIELDS.includes(f))
      : existing.pastedFields || [],
    pasteSamples: input.pasteSamples !== undefined ? sanitizePasteSamples(input.pasteSamples) : (existing.pasteSamples || {}),
    awayCount: clampInt(input.awayCount ?? existing.awayCount, 0, 1000),
    awayTotalMs: clampInt(input.awayTotalMs ?? existing.awayTotalMs, 0, 86400000),
    durationMs: clampInt(input.durationMs ?? existing.durationMs, 0, 86400000),
    similarityFlags: existing.similarityFlags || [],
    typingStats: existing.typingStats || {},
    typingReplay: input.typingReplay !== undefined ? sanitizeTypingReplay(input.typingReplay) : (existing.typingReplay || {}),
    notes: existing.notes || [],
    auditLog: existing.auditLog || [],
    archived: Boolean(existing.archived),
    archivedAt: existing.archivedAt || ""
  };
}

function normalizeForCompare(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function shingleSet(text, n = 5) {
  const words = normalizeForCompare(text).split(" ").filter(Boolean);
  const set = new Set();
  if (words.length < n) {
    if (words.length) set.add(words.join(" "));
    return set;
  }
  for (let i = 0; i <= words.length - n; i++) {
    set.add(words.slice(i, i + n).join(" "));
  }
  return set;
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

const SIMILARITY_FIELDS = ["roleplayPhilosophy", "characterDescription", "leoExperience", "bannedHistory"];
const SIMILARITY_THRESHOLD = 0.5;
const MIN_WORDS_FOR_SIMILARITY = 25;

// Flags near-duplicate essay answers against prior applications (a template
// or AI answer circulating in the community, or the same person reapplying
// with unchanged text) — a signal for reviewers, not an automatic rejection.
function findSimilarApplications(candidate, existingApplications) {
  const flags = [];
  for (const field of SIMILARITY_FIELDS) {
    const words = normalizeForCompare(candidate[field]).split(" ").filter(Boolean);
    if (words.length < MIN_WORDS_FOR_SIMILARITY) continue;
    const candidateShingles = shingleSet(candidate[field]);
    let best = null;
    for (const other of existingApplications) {
      if (!other[field]) continue;
      const otherWords = normalizeForCompare(other[field]).split(" ").filter(Boolean);
      if (otherWords.length < MIN_WORDS_FOR_SIMILARITY) continue;
      const similarity = jaccardSimilarity(candidateShingles, shingleSet(other[field]));
      if (similarity >= SIMILARITY_THRESHOLD && (!best || similarity > best.similarity)) {
        best = { field, similarity, applicationId: other.id, applicantName: other.name };
      }
    }
    if (best) flags.push(best);
  }
  return flags;
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(publicDir, cleanPath));
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    send(res, 403, "Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": cacheControlFor(ext),
    });
    res.end(file);
  } catch {
    const fallback = await fs.readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, {
      "content-type": mimeTypes[".html"],
      "cache-control": cacheControlFor(".html"),
    });
    res.end(fallback);
  }
}

// HTML must always revalidate so deploys take effect immediately. Other assets
// (app.js, styles.css) are busted via ?v= query params, so they can cache hard.
function cacheControlFor(ext) {
  if (ext === ".html" || ext === "") return "no-cache, must-revalidate";
  return "public, max-age=31536000";
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const user = await currentUser(req);

  if (req.method === "GET" && url.pathname === "/api/roster") {
    // This route is public — the audit trail (who changed what, with emails)
    // is staff-only and is served separately by /api/roster/audit.
    const { auditLog, ...roster } = await readJson(rosterPath);
    send(res, 200, roster);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/roster/audit") {
    if (!requireEdit(user, res)) return;
    const data = await readJson(rosterPath);
    send(res, 200, { auditLog: (data.auditLog || []).slice(0, 200) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    send(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/applications") {
    const payload = await bodyJson(req);
    const next = sanitizeApplication(payload);
    if (!next.name || !next.discord || !next.roleplayPhilosophy || !next.characterDescription || !next.bannedHistory) {
      send(res, 400, { error: "Name, Discord, and all required essay fields are required." });
      return;
    }

    const data = await readJson(applicationsPath);
    next.similarityFlags = findSimilarApplications(next, data.applications);
    next.typingStats = computeTypingStats(next.typingReplay);
    next.auditLog = [{ at: next.submittedAt, by: "applicant", action: "submitted" }];
    data.applications.unshift(next);
    await writeJson(applicationsPath, data);

    // Add card to onboarding board
    const board = await readJson(onboardingPath);
    board.cards.unshift({
      id: next.id,
      name: next.name,
      discord: next.discord,
      applicationId: next.id,
      rosterId: "",
      stage: "Application Pending",
      createdAt: new Date().toISOString(),
      stageEnteredAt: new Date().toISOString()
    });
    await writeJson(onboardingPath, board);

    send(res, 201, { application: next });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const credentials = await bodyJson(req);
    const password = String(credentials.password || "");
    const data = await readJson(usersPath);
    const matched = data.users.find(
      (candidate) =>
        candidate.email.toLowerCase() === String(credentials.email || "").trim().toLowerCase() &&
        verifyPassword(password, candidate.password)
    );
    if (!matched) {
      send(res, 401, { error: "Invalid email or password." });
      return;
    }
    if (!isHashedPassword(matched.password)) {
      matched.password = hashPassword(password);
      await writeJson(usersPath, data);
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: matched.id, createdAt: Date.now() });
    send(res, 200, { user: publicUser(matched) }, {
      "set-cookie": `pd_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = cookieValue(req, "pd_session");
    if (token) sessions.delete(token);
    send(res, 200, { ok: true }, {
      "set-cookie": "pd_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    });
    return;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/roster/")) {
    if (!requireEdit(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const payload = await bodyJson(req);
    const data = await readJson(rosterPath);
    const index = data.roster.findIndex((entry) => entry.id === id);
    if (index === -1) {
      send(res, 404, { error: "Roster entry not found." });
      return;
    }

    const currentCallsign = String(data.roster[index].callsign || "").trim();
    const newCallsign = String(payload.callsign || "").trim();
    const callsignChanged = newCallsign && newCallsign !== currentCallsign;

    if (callsignChanged) {
      const conflict = occupiedCallsignConflict(data.roster, newCallsign, id);
      if (conflict) {
        send(res, 409, { error: `Callsign ${newCallsign} is already assigned to ${conflict.name}.` });
        return;
      }
      // Find the existing slot with the target callsign and move the person there
      const targetIdx = data.roster.findIndex(
        (e, i) => i !== index && String(e.callsign || "").trim() === newCallsign
      );
      if (targetIdx !== -1) {
        // Move person's data into the target slot (preserve target slot's id/callsign)
        data.roster[targetIdx] = sanitizeRosterEntry(payload, data.roster[targetIdx]);
        // Vacate the source slot (restore its original callsign)
        data.roster[index] = {
          ...data.roster[index],
          callsign: currentCallsign,
          name: "", activity: "Vacant", vacant: true,
          notes: "", employeeNotes: "", clearedForPatrol: false, promotionDate: "",
          updatedAt: new Date().toISOString(),
        };
        data.updatedAt = new Date().toISOString();
        data.updatedBy = user.email;
        recordRosterAudit(data, user, "reassigned", data.roster[targetIdx], [
          { field: "callsign", from: currentCallsign, to: newCallsign }
        ]);
        await writeJson(rosterPath, data);
        send(res, 200, data.roster[targetIdx]);
        return;
      }
    }

    const previousEntry = data.roster[index];
    data.roster[index] = sanitizeRosterEntry(payload, previousEntry);
    data.updatedAt = new Date().toISOString();
    data.updatedBy = user.email;
    recordRosterAudit(data, user, "updated", data.roster[index], rosterDiff(previousEntry, data.roster[index]));
    await writeJson(rosterPath, data);
    send(res, 200, data.roster[index]);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/roster") {
    if (!requireEdit(user, res)) return;
    const payload = await bodyJson(req);
    const data = await readJson(rosterPath);
    const callsign = String(payload.callsign || "").trim();
    const conflict = occupiedCallsignConflict(data.roster, callsign);
    if (conflict) {
      send(res, 409, { error: `Callsign ${callsign} is already assigned to ${conflict.name}.` });
      return;
    }
    const existingIndex = callsign
      ? data.roster.findIndex((e) => String(e.callsign || "").trim() === callsign)
      : -1;

    if (existingIndex !== -1) {
      // Callsign matches an existing vacant slot — fill it instead of creating a duplicate row.
      const existing = data.roster[existingIndex];
      const entry = sanitizeRosterEntry(payload, existing);
      data.roster[existingIndex] = entry;
      data.updatedAt = new Date().toISOString();
      data.updatedBy = user.email;
      recordRosterAudit(data, user, "filled slot", entry, rosterDiff(existing, entry));
      await writeJson(rosterPath, data);
      send(res, 201, entry);
      return;
    }

    const entry = sanitizeRosterEntry(payload);
    data.roster.push(entry);
    data.updatedAt = new Date().toISOString();
    data.updatedBy = user.email;
    recordRosterAudit(data, user, "created", entry, rosterDiff({}, entry));
    await writeJson(rosterPath, data);
    send(res, 201, entry);
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/roster/")) {
    if (!requireEdit(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const data = await readJson(rosterPath);
    const idx = data.roster.findIndex((e) => e.id === id);
    if (idx !== -1) {
      recordRosterAudit(data, user, "vacated", data.roster[idx], [
        { field: "name", from: String(data.roster[idx].name || ""), to: "" },
        { field: "activity", from: String(data.roster[idx].activity || ""), to: "Vacant" }
      ]);
      // Vacate the slot so the callsign stays available — don't delete the entry
      data.roster[idx].name = "";
      data.roster[idx].activity = "Vacant";
      data.roster[idx].vacant = true;
      data.roster[idx].notes = "";
      data.roster[idx].employeeNotes = "";
      data.roster[idx].clearedForPatrol = false;
      data.roster[idx].promotionDate = "";
      data.roster[idx].updatedAt = new Date().toISOString();
    }
    data.updatedAt = new Date().toISOString();
    data.updatedBy = user.email;
    await writeJson(rosterPath, data);
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/applications/status") {
    const id = url.searchParams.get("id");
    const discord = url.searchParams.get("discord");
    const data = await readJson(applicationsPath);
    const application = id
      ? data.applications.find((a) => a.id === id)
      : discord
        ? data.applications.find((a) => a.discord.toLowerCase() === discord.trim().toLowerCase())
        : null;
    if (!application) {
      send(res, 404, { error: "No application found." });
      return;
    }
    send(res, 200, {
      name: application.name,
      discord: application.discord,
      status: application.status,
      submittedAt: application.submittedAt,
      reviewedAt: application.reviewedAt || ""
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/applications") {
    if (!requireReviewApplications(user, res)) return;
    const data = await readJson(applicationsPath);
    // typingReplay is by far the largest part of an application and is only
    // needed when a reviewer actually opens a replay, so it's fetched
    // per-application from /api/applications/:id/replay instead of being
    // shipped for every applicant on every dashboard load.
    send(res, 200, {
      applications: data.applications.map(({ typingReplay, ...rest }) => ({
        ...rest,
        replayFields: Object.keys(typingReplay || {})
      }))
    });
    return;
  }

  if (req.method === "GET" && url.pathname.match(/^\/api\/applications\/[^/]+\/replay$/)) {
    if (!requireReviewApplications(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const data = await readJson(applicationsPath);
    const application = data.applications.find((a) => a.id === id);
    if (!application) {
      send(res, 404, { error: "Application not found." });
      return;
    }
    send(res, 200, { typingReplay: application.typingReplay || {} });
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/applications\/[^/]+\/notes$/)) {
    if (!requireReviewApplications(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const payload = await bodyJson(req);
    const text = String(payload.text || "").trim();
    if (!text) {
      send(res, 400, { error: "Note text is required." });
      return;
    }
    const data = await readJson(applicationsPath);
    const index = data.applications.findIndex((a) => a.id === id);
    if (index === -1) {
      send(res, 404, { error: "Application not found." });
      return;
    }
    const note = {
      id: crypto.randomUUID(),
      text: text.slice(0, 2000),
      author: user.name,
      authorEmail: user.email,
      createdAt: new Date().toISOString()
    };
    const application = data.applications[index];
    application.notes = [...(application.notes || []), note];
    application.auditLog = [...(application.auditLog || []), {
      at: note.createdAt, by: user.email, action: "note added"
    }];
    await writeJson(applicationsPath, data);
    send(res, 201, { note });
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/applications\/[^/]+\/archive$/)) {
    if (!requireReviewApplications(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const payload = await bodyJson(req).catch(() => ({}));
    const archived = payload.archived !== false;
    const data = await readJson(applicationsPath);
    const index = data.applications.findIndex((a) => a.id === id);
    if (index === -1) {
      send(res, 404, { error: "Application not found." });
      return;
    }
    const now = new Date().toISOString();
    const application = data.applications[index];
    application.archived = archived;
    application.archivedAt = archived ? now : "";
    application.auditLog = [...(application.auditLog || []), {
      at: now, by: user.email, action: archived ? "archived" : "unarchived"
    }];
    await writeJson(applicationsPath, data);
    send(res, 200, { application: { ...application, typingReplay: undefined } });
    return;
  }

  if (req.method === "DELETE" && url.pathname.match(/^\/api\/applications\/[^/]+$/)) {
    if (!requireManageUsers(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const data = await readJson(applicationsPath);
    const index = data.applications.findIndex((a) => a.id === id);
    if (index === -1) {
      send(res, 404, { error: "Application not found." });
      return;
    }
    data.applications.splice(index, 1);
    await writeJson(applicationsPath, data);

    // Drop any onboarding card pointing at the now-deleted application.
    const board = await readJson(onboardingPath);
    const before = board.cards.length;
    board.cards = board.cards.filter((c) => c.applicationId !== id);
    if (board.cards.length !== before) await writeJson(onboardingPath, board);

    console.log(`Application ${id} permanently deleted by ${user.email}.`);
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/applications\/[^/]+\/reject$/)) {
    if (!requireReviewApplications(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const data = await readJson(applicationsPath);
    const index = data.applications.findIndex((application) => application.id === id);
    if (index === -1) {
      send(res, 404, { error: "Application not found." });
      return;
    }
    const rejPayload = await bodyJson(req).catch(() => ({}));
    const rejectedAt = new Date().toISOString();
    data.applications[index] = sanitizeApplication({
      ...data.applications[index],
      status: "rejected",
      rejectionReason: String(rejPayload.reason || "").trim() || null,
      rejectionNotes: String(rejPayload.notes || "").trim() || null,
      reviewedAt: rejectedAt,
      reviewedBy: user.email
    }, data.applications[index]);
    data.applications[index].auditLog = [...(data.applications[index].auditLog || []), {
      at: rejectedAt, by: user.email, action: "rejected"
    }];
    await writeJson(applicationsPath, data);

    // Remove from onboarding board
    const board = await readJson(onboardingPath);
    board.cards = board.cards.filter((c) => c.applicationId !== id);
    await writeJson(onboardingPath, board);

    send(res, 200, { application: data.applications[index] });
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/applications\/[^/]+\/accept$/)) {
    if (!requireReviewApplications(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    await bodyJson(req).catch(() => ({})); // drain the request body; nothing in it is needed now
    const applications = await readJson(applicationsPath);
    const index = applications.applications.findIndex((application) => application.id === id);
    if (index === -1) {
      send(res, 404, { error: "Application not found." });
      return;
    }
    if (applications.applications[index].status === "accepted") {
      send(res, 409, { error: "Application has already been accepted." });
      return;
    }

    // Accepting no longer touches the roster at all. A callsign is a roster
    // slot, and assigning one used to make acceptance a roster write — which
    // is what blocked onboarding-only staff from accepting anyone. Recruits
    // now live on the pipeline board until Academy Passed, where a rank and
    // callsign get picked together.
    const application = applications.applications[index];
    const acceptedAt = new Date().toISOString();
    applications.applications[index] = sanitizeApplication({
      ...application,
      status: "accepted",
      reviewedAt: acceptedAt,
      reviewedBy: user.email
    }, application);
    applications.applications[index].auditLog = [...(application.auditLog || []), {
      at: acceptedAt, by: user.email, action: "accepted"
    }];
    await writeJson(applicationsPath, applications);

    // Advance onboarding card to Application Accepted
    const board = await readJson(onboardingPath);
    const cardIdx = board.cards.findIndex((c) => c.applicationId === id);
    if (cardIdx !== -1) {
      board.cards[cardIdx].stage = "Application Accepted";
      board.cards[cardIdx].acceptedBy = user.name;
      board.cards[cardIdx].stageEnteredAt = new Date().toISOString();
    }
    await writeJson(onboardingPath, board);

    send(res, 201, { application: applications.applications[index] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    if (!requireManageUsers(user, res)) return;
    const { users } = await readJson(usersPath);
    send(res, 200, { users: users.map(publicUser) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    if (!requireManageUsers(user, res)) return;
    const payload = await bodyJson(req);
    const data = await readJson(usersPath);
    const next = sanitizeUser(payload);
    if (!next.email || !next.name) {
      send(res, 400, { error: "Name and email are required." });
      return;
    }
    if (authorityOf(next) >= authorityOf(user)) {
      send(res, 403, { error: "You cannot create an account at or above your own permission level." });
      return;
    }
    if (data.users.some((candidate) => candidate.email === next.email)) {
      send(res, 409, { error: "A user with that email already exists." });
      return;
    }
    data.users.push(next);
    await writeJson(usersPath, data);
    send(res, 201, publicUser(next));
    return;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/users/")) {
    if (!requireManageUsers(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const payload = await bodyJson(req);
    const data = await readJson(usersPath);
    const index = data.users.findIndex((candidate) => candidate.id === id);
    if (index === -1) {
      send(res, 404, { error: "User not found." });
      return;
    }
    // Without this any manage-users account could PUT itself (or an admin)
    // to full permissions — the ladder has to be enforced on the write, not
    // just hidden in the dashboard.
    const reach = targetOutOfReach(user, data.users[index], { allowSelf: true });
    if (reach) {
      send(res, 403, { error: reach });
      return;
    }
    const next = sanitizeUser(payload, data.users[index]);
    const isSelf = user.id === data.users[index].id;
    if (isSelf && !samePermissions(next, data.users[index])) {
      send(res, 403, { error: "You cannot change your own role or permissions." });
      return;
    }
    if (!isSelf && authorityOf(next) >= authorityOf(user)) {
      send(res, 403, { error: "You cannot grant permissions at or above your own level." });
      return;
    }
    if (data.users.some((candidate) => candidate.id !== id && candidate.email === next.email)) {
      send(res, 409, { error: "A user with that email already exists." });
      return;
    }
    data.users[index] = next;
    await writeJson(usersPath, data);
    send(res, 200, publicUser(data.users[index]));
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/users/")) {
    if (!requireManageUsers(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const data = await readJson(usersPath);
    const index = data.users.findIndex((candidate) => candidate.id === id);
    if (index === -1) {
      send(res, 404, { error: "User not found." });
      return;
    }
    const reach = targetOutOfReach(user, data.users[index]);
    if (reach) {
      send(res, 403, { error: reach });
      return;
    }
    // Belt and braces: even an admin can't remove the last account capable of
    // managing users, or nobody can administer the site again without hand
    // editing users.json on the volume.
    const remainingManagers = data.users.filter(
      (candidate) => candidate.id !== id && effectivePermissions(candidate).canManageUsers
    );
    if (!remainingManagers.length) {
      send(res, 409, { error: "This is the last account that can manage users." });
      return;
    }
    const [removed] = data.users.splice(index, 1);
    await writeJson(usersPath, data);
    // Kill any live session for the deleted account so they're logged out now
    // rather than at the end of their 8h cookie.
    for (const [token, session] of sessions) {
      if (session.userId === id) sessions.delete(token);
    }
    console.log(`User ${removed.email} deleted by ${user.email}.`);
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/ranks") {
    send(res, 200, await readRanks());
    return;
  }

  // ── Discord ──
  // Everything below is inert unless the matching environment variables are
  // set on the host. No route here reads, writes, returns, or accepts a token.

  if (req.method === "GET" && url.pathname === "/api/discord/config") {
    if (!requireUser(user, res)) return;
    const config = discordConfig();
    send(res, 200, {
      oauthEnabled: config.oauthEnabled,
      roleSyncEnabled: config.roleSyncEnabled,
      botEnabled: config.botEnabled,
      notifyEnabled: config.notifyEnabled,
      features: featureSwitches(),
      linked: publicUser(user).discord || null
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/discord/link") {
    if (!requireUser(user, res)) return;
    if (!discordConfig().oauthEnabled) {
      send(res, 503, { error: "Discord linking is not enabled on this server." });
      return;
    }
    // Single-use, short-lived, and bound to the signed-in account, so a
    // callback can't be replayed or aimed at somebody else's user record.
    const state = crypto.randomBytes(24).toString("hex");
    oauthStates.set(state, { userId: user.id, createdAt: Date.now() });
    send(res, 200, { url: buildAuthorizeUrl(state) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/discord/callback") {
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    const pending = oauthStates.get(state);
    oauthStates.delete(state);
    if (!pending || Date.now() - pending.createdAt > OAUTH_STATE_TTL_MS) {
      send(res, 400, { error: "This Discord link request expired. Try again." });
      return;
    }
    try {
      const accessToken = await exchangeCode(code);
      const identity = await fetchIdentity(accessToken);
      const roleIds = await fetchGuildRoles(accessToken);
      const data = await readJson(usersPath);
      const index = data.users.findIndex((candidate) => candidate.id === pending.userId);
      if (index === -1) {
        send(res, 404, { error: "Account no longer exists." });
        return;
      }
      const taken = data.users.find(
        (candidate) => candidate.id !== pending.userId && candidate.discord?.id === identity.id
      );
      if (taken) {
        send(res, 409, { error: "That Discord account is already linked to another user." });
        return;
      }
      data.users[index].discord = sanitizeDiscordLink({
        ...identity, roleIds, linkedAt: new Date().toISOString(), syncedAt: new Date().toISOString()
      });
      await applyDiscordPermissions(data.users[index], roleIds);
      await writeJson(usersPath, data);
      send(res, 302, "", { location: "/#dashboard" });
      return;
    } catch (error) {
      send(res, error.statusCode || 502, { error: `Discord link failed: ${error.message}` });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/discord/unlink") {
    if (!requireUser(user, res)) return;
    const data = await readJson(usersPath);
    const index = data.users.findIndex((candidate) => candidate.id === user.id);
    if (index !== -1) {
      data.users[index].discord = null;
      await writeJson(usersPath, data);
    }
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/discord/settings") {
    if (!requireManageUsers(user, res)) return;
    send(res, 200, await readDiscordSettings());
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/discord/settings") {
    if (!requireManageUsers(user, res)) return;
    const payload = await bodyJson(req);
    const next = {
      ...sanitizeDiscordSettings(payload),
      updatedAt: new Date().toISOString(),
      updatedBy: user.email
    };
    await writeJson(discordPath, next);
    send(res, 200, next);
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/ranks") {
    if (!requireManageRanks(user, res)) return;
    const payload = await bodyJson(req);
    const ranks = sanitizeRankList(payload.ranks);
    if (!ranks.length) {
      send(res, 400, { error: "At least one rank is required." });
      return;
    }
    const roster = await readJson(rosterPath);
    const inUse = ranksInUse(roster.roster);
    const keptNames = new Set(ranks.map((rank) => rank.name.toLowerCase()));
    for (const rank of await readRanks().then((data) => data.ranks)) {
      const key = rank.name.toLowerCase();
      if (!keptNames.has(key) && inUse.get(key)) {
        send(res, 409, {
          error: `${rank.name} is still assigned to ${inUse.get(key)} roster entr${inUse.get(key) === 1 ? "y" : "ies"}. Move them to another rank first.`
        });
        return;
      }
    }
    const next = { ranks, updatedAt: new Date().toISOString(), updatedBy: user.email };
    await writeJson(ranksPath, next);
    send(res, 200, next);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ranks/restore") {
    if (!requireManageRanks(user, res)) return;
    const seed = JSON.parse(await fs.readFile(path.join(seedDir, "ranks.json"), "utf8"));
    const next = {
      ranks: sanitizeRankList(seed.ranks),
      updatedAt: new Date().toISOString(),
      updatedBy: `${user.email} (restored defaults)`
    };
    await writeJson(ranksPath, next);
    send(res, 200, next);
    return;
  }

  if (req.method === "DELETE" && url.pathname.match(/^\/api\/onboarding\/[^/]+$/)) {
    if (!requireOnboard(user, res)) return;
    const cardId = decodeURIComponent(url.pathname.split("/").pop());
    const board = await readJson(onboardingPath);
    const cardIdx = board.cards.findIndex((c) => c.id === cardId);
    if (cardIdx === -1) { send(res, 404, { error: "Card not found." }); return; }

    const card = board.cards[cardIdx];

    // Vacate the roster entry so the callsign stays available
    if (card.rosterId) {
      const roster = await readJson(rosterPath);
      const rIdx = roster.roster.findIndex((e) => e.id === card.rosterId);
      if (rIdx !== -1) {
        recordRosterAudit(roster, user, "terminated (pipeline)", roster.roster[rIdx], [
          { field: "name", from: String(roster.roster[rIdx].name || ""), to: "" },
          { field: "activity", from: String(roster.roster[rIdx].activity || ""), to: "Vacant" }
        ]);
        roster.roster[rIdx].name = "";
        roster.roster[rIdx].activity = "Vacant";
        roster.roster[rIdx].vacant = true;
        roster.roster[rIdx].notes = "";
        roster.roster[rIdx].employeeNotes = "";
        roster.roster[rIdx].clearedForPatrol = false;
        roster.roster[rIdx].promotionDate = "";
        roster.roster[rIdx].updatedAt = new Date().toISOString();
      }
      roster.updatedAt = new Date().toISOString();
      roster.updatedBy = user.email;
      await writeJson(rosterPath, roster);
    }

    // Mark application as terminated
    if (card.applicationId) {
      const apps = await readJson(applicationsPath);
      const appIdx = apps.applications.findIndex((a) => a.id === card.applicationId);
      if (appIdx !== -1) {
        apps.applications[appIdx].status = "rejected";
        apps.applications[appIdx].reviewedAt = new Date().toISOString();
        apps.applications[appIdx].reviewedBy = user.email;
        await writeJson(applicationsPath, apps);
      }
    }

    // Remove card from board
    board.cards.splice(cardIdx, 1);
    await writeJson(onboardingPath, board);
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/onboarding") {
    // Roster editors need this too — the callsign approval queue lives here,
    // and approving is their job, not the onboarding team's.
    if (!requireUser(user, res)) return;
    const perms = effectivePermissions(user);
    if (!perms.canOnboard && !perms.canEditRoster) {
      send(res, 403, { error: "Onboarding permission required." });
      return;
    }
    const board = await readJson(onboardingPath);
    send(res, 200, { ...board, stages: ONBOARDING_STAGES });
    return;
  }

  if (req.method === "PUT" && url.pathname.match(/^\/api\/onboarding\/[^/]+$/)) {
    if (!requireOnboard(user, res)) return;
    const cardId = decodeURIComponent(url.pathname.split("/").pop());
    const payload = await bodyJson(req);
    const board = await readJson(onboardingPath);
    const cardIdx = board.cards.findIndex((c) => c.id === cardId);
    if (cardIdx === -1) { send(res, 404, { error: "Card not found." }); return; }

    const stage = String(payload.stage || "").trim();
    if (!ONBOARDING_STAGES.includes(stage)) {
      send(res, 400, { error: "Unknown pipeline stage." });
      return;
    }

    const card = board.cards[cardIdx];
    card.stage = stage;
    card.movedBy = user.name;
    card.movedAt = new Date().toISOString();
    card.stageEnteredAt = new Date().toISOString();

    // Stages that put someone in a callsign. Assigning one is a roster write,
    // so onboarding staff can move the card but the callsign itself waits for
    // somebody with canEditRoster — the request is queued on the card and
    // shows up in the dashboard's callsign approval queue.
    const stageRank = CALLSIGN_STAGES[stage];
    if (stageRank) {
      const rank = String(payload.rank || stageRank).trim();
      if (payload.callsign && effectivePermissions(user).canEditRoster) {
        const failure = await assignCallsignToCard(card, { callsign: payload.callsign, rank, user });
        if (failure) { send(res, 409, { error: failure }); return; }
      } else {
        card.pendingCallsign = {
          stage,
          rank,
          requestedBy: user.name,
          requestedByEmail: user.email,
          requestedAt: new Date().toISOString()
        };
      }
    } else {
      // Moved off a callsign stage before anyone approved it — drop the
      // request rather than leaving it queued against the wrong stage.
      card.pendingCallsign = null;
    }

    // Sync clearedForPatrol on roster entry based on stage
    if (card.rosterId) {
      const roster = await readJson(rosterPath);
      const rIdx = roster.roster.findIndex((e) => e.id === card.rosterId);
      if (rIdx !== -1) {
        roster.roster[rIdx].clearedForPatrol = stage === "Cleared For Patrol";
        roster.roster[rIdx].updatedAt = new Date().toISOString();
        await writeJson(rosterPath, roster);
      }
    }

    await writeJson(onboardingPath, board);
    send(res, 200, { card });
    return;
  }

  // Approving a queued callsign request. requireEdit, not requireOnboard —
  // this is the roster write the queue exists to gate.
  if (req.method === "POST" && url.pathname.match(/^\/api\/onboarding\/[^/]+\/callsign$/)) {
    if (!requireEdit(user, res)) return;
    const cardId = decodeURIComponent(url.pathname.split("/")[3]);
    const payload = await bodyJson(req);
    const board = await readJson(onboardingPath);
    const cardIdx = board.cards.findIndex((c) => c.id === cardId);
    if (cardIdx === -1) { send(res, 404, { error: "Card not found." }); return; }
    const card = board.cards[cardIdx];
    const rank = String(payload.rank || card.pendingCallsign?.rank || CALLSIGN_STAGES[card.stage] || "").trim();
    const failure = await assignCallsignToCard(card, { callsign: payload.callsign, rank, user });
    if (failure) { send(res, 409, { error: failure }); return; }
    await writeJson(onboardingPath, board);
    send(res, 200, { card });
    return;
  }

  // Declining a queued request — clears it without touching the roster. The
  // card stays where it is so staff can move it back deliberately.
  if (req.method === "DELETE" && url.pathname.match(/^\/api\/onboarding\/[^/]+\/callsign$/)) {
    if (!requireEdit(user, res)) return;
    const cardId = decodeURIComponent(url.pathname.split("/")[3]);
    const board = await readJson(onboardingPath);
    const cardIdx = board.cards.findIndex((c) => c.id === cardId);
    if (cardIdx === -1) { send(res, 404, { error: "Card not found." }); return; }
    board.cards[cardIdx].pendingCallsign = null;
    await writeJson(onboardingPath, board);
    send(res, 200, { card: board.cards[cardIdx] });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    const payload = await bodyJson(req);
    const name     = String(payload.name     || "").trim();
    const email    = String(payload.email    || "").trim().toLowerCase();
    const password = String(payload.password || "").trim();
    if (!name || !email || !password) {
      send(res, 400, { error: "Name, email, and password are all required." });
      return;
    }
    if (password.length < 6) {
      send(res, 400, { error: "Password must be at least 6 characters." });
      return;
    }
    const data = await readJson(usersPath);
    if (data.users.some((u) => u.email === email)) {
      send(res, 409, { error: "An account with that email already exists." });
      return;
    }
    const newUser = {
      id: crypto.randomUUID(),
      name,
      email,
      password: hashPassword(password),
      role: "viewer",
      canEditRoster: false,
      canManageUsers: false,
      canOnboard: false,
      canManageRanks: false
    };
    data.users.push(newUser);
    await writeJson(usersPath, data);
    // Log them in immediately
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: newUser.id, createdAt: Date.now() });
    send(res, 201, { user: publicUser(newUser) }, {
      "set-cookie": `pd_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
    });
    return;
  }

  // ── Bug reports ──────────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/bugs") {
    const payload = await bodyJson(req);
    const description = String(payload.description || "").trim();
    if (!description) { send(res, 400, { error: "Description is required." }); return; }
    const data = await readJson(bugsPath);
    const report = {
      id: crypto.randomUUID(),
      description,
      section: String(payload.section || "").trim() || "Not specified",
      submittedBy: user ? user.name : (String(payload.name || "").trim() || "Anonymous"),
      submittedEmail: user ? user.email : (String(payload.email || "").trim() || ""),
      submittedAt: new Date().toISOString(),
      status: "open"
    };
    data.reports.unshift(report);
    await writeJson(bugsPath, data);
    send(res, 201, { report });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bugs") {
    if (!requireManageBugs(user, res)) return;
    const data = await readJson(bugsPath);
    send(res, 200, data);
    return;
  }

  if (req.method === "PUT" && url.pathname.match(/^\/api\/bugs\/[^/]+$/)) {
    if (!requireManageBugs(user, res)) return;
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const payload = await bodyJson(req);
    const data = await readJson(bugsPath);
    const idx = data.reports.findIndex((r) => r.id === id);
    if (idx === -1) { send(res, 404, { error: "Report not found." }); return; }
    data.reports[idx] = { ...data.reports[idx], status: payload.status || data.reports[idx].status };
    await writeJson(bugsPath, data);
    send(res, 200, { report: data.reports[idx] });
    return;
  }

  send(res, 404, { error: "Route not found." });
}

async function initDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
  for (const file of ["roster.json", "users.json", "applications.json", "onboarding.json", "bugs.json", "ranks.json"]) {
    const dest = path.join(dataDir, file);
    const seed = path.join(seedDir, file);
    try {
      await fs.access(dest);
    } catch {
      await fs.copyFile(seed, dest);
    }
  }
  await syncSeedImport();
  await restoreMissingSlots();
  await migratePlaintextPasswords();
  await fixStaleVacantFlags();
  await maintainApplications();
}

// Auto-archive decided applications after a while so the inbox stays usable,
// and (only if explicitly configured) purge long-archived ones. Purging is
// off by default because it destroys data — set APPLICATION_PURGE_DAYS to
// opt in, and it always runs at least a full archive window behind.
const APPLICATION_ARCHIVE_DAYS = Number(process.env.APPLICATION_ARCHIVE_DAYS || 30);
const APPLICATION_PURGE_DAYS = Number(process.env.APPLICATION_PURGE_DAYS || 0);

async function maintainApplications() {
  const data = await readJson(applicationsPath);
  const now = Date.now();
  let archived = 0;
  let purged = 0;

  if (APPLICATION_ARCHIVE_DAYS > 0) {
    const cutoff = now - APPLICATION_ARCHIVE_DAYS * 86400000;
    for (const application of data.applications) {
      if (application.archived || application.status === "pending") continue;
      const decidedAt = Date.parse(application.reviewedAt || application.submittedAt);
      if (!decidedAt || decidedAt > cutoff) continue;
      application.archived = true;
      application.archivedAt = new Date().toISOString();
      application.auditLog = [...(application.auditLog || []), {
        at: application.archivedAt, by: "system", action: "auto-archived"
      }];
      archived += 1;
    }
  }

  if (APPLICATION_PURGE_DAYS > 0) {
    const cutoff = now - APPLICATION_PURGE_DAYS * 86400000;
    const before = data.applications.length;
    data.applications = data.applications.filter((application) => {
      if (!application.archived) return true;
      const archivedAt = Date.parse(application.archivedAt);
      return !archivedAt || archivedAt > cutoff;
    });
    purged = before - data.applications.length;
  }

  if (archived || purged) {
    await writeJson(applicationsPath, data);
    console.log(`Applications maintenance: ${archived} auto-archived, ${purged} purged.`);
  }
}

// One-time cleanup for entries saved before sanitizeRosterEntry derived
// `vacant` from activity/name: a filled-in name with a still-checked
// "Vacant slot" box used to save fine but stay hidden by every vacant
// filter in the app. Recompute vacant for every entry on boot.
async function fixStaleVacantFlags() {
  const data = await readJson(rosterPath);
  let changed = false;
  for (const entry of data.roster) {
    const shouldBeVacant = entry.activity === "Vacant" || !String(entry.name || "").trim();
    if (Boolean(entry.vacant) !== shouldBeVacant) {
      entry.vacant = shouldBeVacant;
      changed = true;
    }
  }
  if (changed) {
    await writeJson(rosterPath, data);
    console.log("Fixed stale vacant flag(s) in roster.json.");
  }
}

// One-time upgrade for deployments whose users.json predates password
// hashing (e.g. a volume seeded before this change shipped) — hash any
// plaintext password in place on boot so those accounts can still log in.
async function migratePlaintextPasswords() {
  const data = await readJson(usersPath);
  let changed = false;
  for (const user of data.users) {
    if (!isHashedPassword(user.password)) {
      user.password = hashPassword(user.password);
      changed = true;
    }
  }
  if (changed) {
    await writeJson(usersPath, data);
    console.log("Migrated plaintext password(s) in users.json to scrypt hashes.");
  }
}

// When a fresh roster import is shipped (seed importedAt newer than the live
// file's), the import is the new source of truth — replace the live roster.
async function syncSeedImport() {
  if (path.resolve(dataDir) === path.resolve(seedDir)) return;
  const seed = JSON.parse(await fs.readFile(path.join(seedDir, "roster.json"), "utf8"));
  const live = await readJson(rosterPath);
  const seedImported = Date.parse(seed.importedAt) || 0;
  const liveImported = Date.parse(live.importedAt) || 0;
  if (seedImported > liveImported) {
    await writeJson(rosterPath, seed);
    console.log(`Replaced live roster with seed import from ${seed.importedAt}.`);
  }
}

// Older builds deleted roster entries outright instead of vacating them, so some
// callsigns are gone from the live data. Re-add any callsign that exists in the
// seed roster but not in the live roster, as a vacant slot with its seed rank.
async function restoreMissingSlots() {
  if (path.resolve(dataDir) === path.resolve(seedDir)) return;
  const seed = JSON.parse(await fs.readFile(path.join(seedDir, "roster.json"), "utf8"));
  const live = await readJson(rosterPath);
  const liveCallsigns = new Set(
    live.roster.map((entry) => String(entry.callsign || "").trim()).filter(Boolean)
  );
  const missing = seed.roster.filter((entry) => {
    const callsign = String(entry.callsign || "").trim();
    return callsign && !liveCallsigns.has(callsign);
  });
  if (!missing.length) return;
  for (const entry of missing) {
    live.roster.push({
      ...entry,
      id: entry.id || crypto.randomUUID(),
      name: "",
      activity: "Vacant",
      vacant: true,
      notes: "",
      employeeNotes: "",
      promotionDate: "",
      tig: "",
      clearedForPatrol: false
    });
  }
  live.updatedAt = new Date().toISOString();
  live.updatedBy = "system:restore-missing-slots";
  await writeJson(rosterPath, live);
  console.log(`Restored ${missing.length} missing roster slot(s) from seed.`);
}

// ── Discord bot wiring ─────────────────────────────────────────────────────
// None of this runs unless DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are present
// in the environment. startBot() returns false and opens no socket otherwise.

// A guild member is tied to a roster entry through their linked site account
// first (exact, set by the user themselves via OAuth), falling back to the
// Discord handle stored in the entry's notes field, which is how the roster
// has always recorded it.
async function findRosterEntryForMember(roster, member) {
  const discordId = member?.user?.id;
  const handle = String(member?.user?.username || "").toLowerCase();
  const { users } = await readJson(usersPath);
  const linked = users.find((candidate) => candidate.discord?.id === discordId);
  if (linked) {
    const byName = roster.roster.find(
      (entry) => !entry.vacant && entry.name &&
                 entry.name.trim().toLowerCase() === String(linked.name || "").trim().toLowerCase()
    );
    if (byName) return byName;
  }
  if (!handle) return null;
  return roster.roster.find(
    (entry) => !entry.vacant && String(entry.notes || "").toLowerCase().includes(handle)
  ) || null;
}

const discordActor = { email: "system:discord", name: "Discord sync" };

async function onDiscordMemberUpdate(member) {
  const settings = await readDiscordSettings();
  const features = featureSwitches();
  const nextRoles = member.roles || [];
  const previous = discordRoleCache.get(member.user?.id) || [];
  discordRoleCache.set(member.user?.id, nextRoles);
  const { gained, lost } = diffMappedRoles(previous, nextRoles, settings);
  if (!gained.length && !lost.length) return;

  await withWriteLock(async () => {
    const roster = await readJson(rosterPath);
    const entry = await findRosterEntryForMember(roster, member);
    const { rank } = permissionsForRoles(nextRoles, settings);
    const stillDepartment = permissionsForRoles(nextRoles, settings).matched;

    if (entry && !stillDepartment && features.autoResignOnRankChange) {
      recordRosterAudit(roster, discordActor, "auto-resigned (left department roles)", entry, [
        { field: "name", from: entry.name, to: "" }
      ]);
      Object.assign(entry, {
        name: "", activity: "Vacant", vacant: true, notes: "", employeeNotes: "",
        clearedForPatrol: false, promotionDate: "", updatedAt: new Date().toISOString()
      });
      roster.updatedAt = new Date().toISOString();
      roster.updatedBy = discordActor.email;
      await writeJson(rosterPath, roster);
      await sendChannelMessage(`has been removed from the roster (no department roles).`, {
        mentionUserId: member.user?.id
      });
      return;
    }

    if (entry && rank && rank !== entry.rank) {
      const from = entry.rank;
      recordRosterAudit(roster, discordActor, "rank synced from Discord", entry, [
        { field: "rank", from, to: rank }
      ]);
      entry.rank = rank;
      entry.promotionDate = new Date().toISOString().split("T")[0];
      entry.updatedAt = new Date().toISOString();
      roster.updatedAt = new Date().toISOString();
      roster.updatedBy = discordActor.email;
      await writeJson(rosterPath, roster);
      await sendChannelMessage(`rank updated: **${from || "—"} → ${rank}**.`, {
        mentionUserId: member.user?.id
      });
      return;
    }

    // No roster entry yet, but they picked up a mapped rank — this is the
    // "auto-add recruits" path. Only fills an existing vacant slot for that
    // rank; it never invents a callsign.
    if (!entry && rank && features.autoAddRecruits) {
      const slot = roster.roster.find(
        (candidate) => (candidate.vacant || candidate.activity === "Vacant") &&
                       normalizeRankName(candidate.rank) === normalizeRankName(rank)
      );
      if (!slot) {
        await sendChannelMessage(
          `joined as **${rank}** but there is no vacant ${rank} slot on the roster — add one manually.`,
          { mentionUserId: member.user?.id }
        );
        return;
      }
      Object.assign(slot, {
        name: member.nick || member.user?.global_name || member.user?.username || "",
        activity: "Active",
        vacant: false,
        notes: member.user?.username || "",
        promotionDate: new Date().toISOString().split("T")[0],
        updatedAt: new Date().toISOString()
      });
      recordRosterAudit(roster, discordActor, "auto-added from Discord", slot, rosterDiff({}, slot));
      roster.updatedAt = new Date().toISOString();
      roster.updatedBy = discordActor.email;
      await writeJson(rosterPath, roster);
      await sendChannelMessage(`added to the roster as **${rank}** (${slot.callsign}).`, {
        mentionUserId: member.user?.id
      });
    }
  });
}

async function onDiscordMemberRemove(member) {
  if (!featureSwitches().autoResignOnRankChange) return;
  discordRoleCache.delete(member.user?.id);
  await withWriteLock(async () => {
    const roster = await readJson(rosterPath);
    const entry = await findRosterEntryForMember(roster, member);
    if (!entry) return;
    recordRosterAudit(roster, discordActor, "auto-resigned (left guild)", entry, [
      { field: "name", from: entry.name, to: "" }
    ]);
    Object.assign(entry, {
      name: "", activity: "Vacant", vacant: true, notes: "", employeeNotes: "",
      clearedForPatrol: false, promotionDate: "", updatedAt: new Date().toISOString()
    });
    roster.updatedAt = new Date().toISOString();
    roster.updatedBy = discordActor.email;
    await writeJson(rosterPath, roster);
    await sendChannelMessage(`**${member.user?.username}** left the Discord — their roster slot has been vacated.`);
  });
}

// Last seen roles per member, so GUILD_MEMBER_UPDATE can tell a rank change
// from a nickname edit. Rebuilt naturally as events arrive.
const discordRoleCache = new Map();

// Every handler does read-JSON, check, mutate, write-JSON with no locking —
// two requests racing on the same file could both read before either writes,
// letting both pass a uniqueness check that should only let one through
// (trivially reproducible with a fast double-click on any save button).
// Serializing all state-changing requests through one queue closes that for
// every handler at once instead of adding a lock per read-modify-write site.
// GETs don't need to wait — they don't do a check-then-write.
let writeQueue = Promise.resolve();
function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

const server = http.createServer(async (req, res) => {
  // Every resource is self-hosted (see public/index.html), so a strict
  // same-origin policy costs nothing here. 'unsafe-inline' on style-src
  // covers the inline style="" attributes app.js generates.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  try {
    if (req.url.startsWith("/api/")) {
      if (req.method === "GET") {
        await handleApi(req, res);
      } else {
        await withWriteLock(() => handleApi(req, res));
      }
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    if (error.statusCode) {
      send(res, error.statusCode, { error: error.message });
      return;
    }
    console.error(error);
    send(res, 500, { error: "Server error." });
  }
});

// Lazily-expired sessions (checked on access in currentUser) cover
// correctness; this just keeps the Map from growing forever with entries
// for tokens that are never used again (tab closed, never came back).
setInterval(() => {
  for (const [token, session] of sessions) {
    if (isSessionExpired(session)) sessions.delete(token);
  }
}, 60 * 60 * 1000).unref();

// Railway sends SIGTERM on redeploy; close the gateway socket deliberately so
// Discord sees a clean disconnect rather than a timeout.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopBot();
    server.close(() => process.exit(0));
    // Don't hang forever on a keep-alive connection that never closes.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

initDataDir().then(() => {
  server.listen(port, () => {
    console.log(`PD roster running at http://localhost:${port}`);
    const config = discordConfig();
    const started = startBot({
      onMemberUpdate: (member) => onDiscordMemberUpdate(member).catch((e) => console.error("Discord update failed:", e.message)),
      onMemberAdd: (member) => onDiscordMemberUpdate(member).catch((e) => console.error("Discord add failed:", e.message)),
      onMemberRemove: (member) => onDiscordMemberRemove(member).catch((e) => console.error("Discord remove failed:", e.message))
    });
    console.log(
      `Discord: OAuth linking ${config.oauthEnabled ? "enabled" : "off"}, ` +
      `role sync ${config.roleSyncEnabled ? "enabled" : "off"}, ` +
      `bot ${started ? "connecting" : "off"}.`
    );
  });
});
