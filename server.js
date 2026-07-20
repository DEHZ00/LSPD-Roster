import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const seedDir = path.join(__dirname, "data");
const dataDir = process.env.DATA_DIR || seedDir;
const rosterPath = path.join(dataDir, "roster.json");
const usersPath = path.join(dataDir, "users.json");
const applicationsPath = path.join(dataDir, "applications.json");
const onboardingPath = path.join(dataDir, "onboarding.json");
const bugsPath = path.join(dataDir, "bugs.json");
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

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
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

function publicUser(user) {
  if (!user) return null;
  const { password, ...safe } = user;
  // Admins always get all permissions regardless of what's stored in the file
  if (safe.role === "admin") {
    safe.canEditRoster = true;
    safe.canManageUsers = true;
    safe.canOnboard = true;
  }
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
  if (!user.canEditRoster) {
    send(res, 403, { error: "You do not have roster edit permission." });
    return false;
  }
  return true;
}

function requireManageUsers(user, res) {
  if (!requireUser(user, res)) return false;
  if (!user.canManageUsers) {
    send(res, 403, { error: "Admin user management permission required." });
    return false;
  }
  return true;
}

function requireOnboard(user, res) {
  if (!requireUser(user, res)) return false;
  if (!user.canOnboard && user.role !== "admin") {
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
    canOnboard: Boolean(input.canOnboard)
  };
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
    rosterEntryId: input.rosterEntryId || existing.rosterEntryId || ""
  };
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
    const roster = await readJson(rosterPath);
    send(res, 200, roster);
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
        await writeJson(rosterPath, data);
        send(res, 200, data.roster[targetIdx]);
        return;
      }
    }

    data.roster[index] = sanitizeRosterEntry(payload, data.roster[index]);
    data.updatedAt = new Date().toISOString();
    data.updatedBy = user.email;
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
      await writeJson(rosterPath, data);
      send(res, 201, entry);
      return;
    }

    const entry = sanitizeRosterEntry(payload);
    data.roster.push(entry);
    data.updatedAt = new Date().toISOString();
    data.updatedBy = user.email;
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
    if (!user || (!user.canEditRoster && !user.canOnboard && user.role !== "admin")) {
      send(res, 403, { error: "Forbidden" }); return;
    }
    const applications = await readJson(applicationsPath);
    send(res, 200, applications);
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/applications\/[^/]+\/reject$/)) {
    if (!user || (!user.canEditRoster && !user.canOnboard && user.role !== "admin")) {
      send(res, 403, { error: "Forbidden" }); return;
    }
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const data = await readJson(applicationsPath);
    const index = data.applications.findIndex((application) => application.id === id);
    if (index === -1) {
      send(res, 404, { error: "Application not found." });
      return;
    }
    const rejPayload = await bodyJson(req).catch(() => ({}));
    data.applications[index] = sanitizeApplication({
      ...data.applications[index],
      status: "rejected",
      rejectionReason: String(rejPayload.reason || "").trim() || null,
      rejectionNotes: String(rejPayload.notes || "").trim() || null,
      reviewedAt: new Date().toISOString(),
      reviewedBy: user.email
    }, data.applications[index]);
    await writeJson(applicationsPath, data);

    // Remove from onboarding board
    const board = await readJson(onboardingPath);
    board.cards = board.cards.filter((c) => c.applicationId !== id);
    await writeJson(onboardingPath, board);

    send(res, 200, { application: data.applications[index] });
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/applications\/[^/]+\/accept$/)) {
    if (!user || (!user.canEditRoster && !user.canOnboard && user.role !== "admin")) {
      send(res, 403, { error: "Forbidden" }); return;
    }
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const payload = await bodyJson(req);
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

    const roster = await readJson(rosterPath);
    const application = applications.applications[index];
    const notes = application.discord ? application.discord : "";

    let entry;
    const vacantIndex = payload.vacantEntryId
      ? roster.roster.findIndex((e) => e.id === payload.vacantEntryId)
      : -1;

    if (vacantIndex !== -1) {
      entry = sanitizeRosterEntry({
        ...roster.roster[vacantIndex],
        name: application.name,
        callsign: payload.callsign || roster.roster[vacantIndex].callsign,
        activity: "Active",
        rank: payload.rank || roster.roster[vacantIndex].rank,
        notes,
        promotionDate: payload.promotionDate || new Date().toLocaleDateString("en-US"),
        tig: "",
        vacant: false
      }, roster.roster[vacantIndex]);
      roster.roster[vacantIndex] = entry;
    } else {
      const callsign = String(payload.callsign || "").trim();
      const conflict = occupiedCallsignConflict(roster.roster, callsign);
      if (conflict) {
        send(res, 409, { error: `Callsign ${callsign} is already assigned to ${conflict.name}.` });
        return;
      }
      entry = sanitizeRosterEntry({
        callsign: payload.callsign,
        name: application.name,
        activity: "Active",
        rank: payload.rank || "Cadet",
        divisions: {},
        strikes: {},
        notes,
        promotionDate: payload.promotionDate || new Date().toLocaleDateString("en-US"),
        tig: "",
        vacant: false
      });
      roster.roster.push(entry);
    }
    roster.updatedAt = new Date().toISOString();
    roster.updatedBy = user.email;
    await writeJson(rosterPath, roster);

    applications.applications[index] = sanitizeApplication({
      ...application,
      status: "accepted",
      reviewedAt: new Date().toISOString(),
      reviewedBy: user.email,
      rosterEntryId: entry.id
    }, application);
    await writeJson(applicationsPath, applications);

    // Advance onboarding card to Application Accepted
    const board = await readJson(onboardingPath);
    const cardIdx = board.cards.findIndex((c) => c.applicationId === id);
    if (cardIdx !== -1) {
      board.cards[cardIdx].stage = "Application Accepted";
      board.cards[cardIdx].rosterId = entry.id;
      board.cards[cardIdx].acceptedBy = user.name;
      board.cards[cardIdx].callsign = entry.callsign;
      board.cards[cardIdx].rank = entry.rank;
      board.cards[cardIdx].stageEnteredAt = new Date().toISOString();
    }
    await writeJson(onboardingPath, board);

    send(res, 201, { application: applications.applications[index], rosterEntry: entry });
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
    const next = sanitizeUser(payload, data.users[index]);
    if (data.users.some((candidate) => candidate.id !== id && candidate.email === next.email)) {
      send(res, 409, { error: "A user with that email already exists." });
      return;
    }
    data.users[index] = next;
    await writeJson(usersPath, data);
    send(res, 200, publicUser(data.users[index]));
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
    if (!requireOnboard(user, res)) return;
    const board = await readJson(onboardingPath);
    send(res, 200, board);
    return;
  }

  if (req.method === "PUT" && url.pathname.match(/^\/api\/onboarding\/[^/]+$/)) {
    if (!requireOnboard(user, res)) return;
    const cardId = decodeURIComponent(url.pathname.split("/").pop());
    const payload = await bodyJson(req);
    const board = await readJson(onboardingPath);
    const cardIdx = board.cards.findIndex((c) => c.id === cardId);
    if (cardIdx === -1) { send(res, 404, { error: "Card not found." }); return; }

    board.cards[cardIdx].stage = payload.stage;
    board.cards[cardIdx].movedBy = user.name;
    board.cards[cardIdx].movedAt = new Date().toISOString();
    board.cards[cardIdx].stageEnteredAt = new Date().toISOString();

    // Academy Passed → promote to selected rank and fill the chosen vacant slot
    if (payload.stage === "Academy Passed" && payload.callsign) {
      const newRank = String(payload.rank || "Probationary Officer").trim();
      const roster = await readJson(rosterPath);

      // Find the vacant slot with the selected callsign
      const vacantIdx = roster.roster.findIndex(
        (e) => (e.vacant || e.activity === "Vacant") &&
                String(e.callsign).trim() === String(payload.callsign).trim()
      );

      if (vacantIdx !== -1) {
        // Fill the vacant slot with the recruit's details
        const card = board.cards[cardIdx];
        roster.roster[vacantIdx].name = card.name;
        roster.roster[vacantIdx].rank = newRank;
        roster.roster[vacantIdx].activity = "Active";
        roster.roster[vacantIdx].vacant = false;
        roster.roster[vacantIdx].notes = card.discord || "";
        roster.roster[vacantIdx].promotionDate = new Date().toISOString().split("T")[0];
        roster.roster[vacantIdx].updatedAt = new Date().toISOString();

        // Vacate the recruit's old slot (if it exists and is a different entry)
        const oldRosterId = board.cards[cardIdx].rosterId;
        if (oldRosterId && oldRosterId !== roster.roster[vacantIdx].id) {
          const oldIdx = roster.roster.findIndex((e) => e.id === oldRosterId);
          if (oldIdx !== -1) {
            roster.roster[oldIdx].name = "";
            roster.roster[oldIdx].activity = "Vacant";
            roster.roster[oldIdx].vacant = true;
            roster.roster[oldIdx].notes = "";
            roster.roster[oldIdx].promotionDate = "";
            roster.roster[oldIdx].updatedAt = new Date().toISOString();
          }
        }

        // Point the card's rosterId at the new PO slot
        board.cards[cardIdx].rosterId = roster.roster[vacantIdx].id;
      } else if (board.cards[cardIdx].rosterId) {
        // Fallback: no matching vacant slot, just update the existing entry in place
        const rIdx = roster.roster.findIndex((e) => e.id === board.cards[cardIdx].rosterId);
        if (rIdx !== -1) {
          const callsign = String(payload.callsign || "").trim();
          const conflict = occupiedCallsignConflict(roster.roster, callsign, roster.roster[rIdx].id);
          if (conflict) {
            send(res, 409, { error: `Callsign ${callsign} is already assigned to ${conflict.name}.` });
            return;
          }
          roster.roster[rIdx].rank = newRank;
          roster.roster[rIdx].callsign = payload.callsign;
          roster.roster[rIdx].activity = "Active";
          roster.roster[rIdx].vacant = false;
          roster.roster[rIdx].updatedAt = new Date().toISOString();
        }
      }

      board.cards[cardIdx].callsign = payload.callsign;
      board.cards[cardIdx].rank = newRank;
      roster.updatedAt = new Date().toISOString();
      roster.updatedBy = user.email;
      await writeJson(rosterPath, roster);
    }

    // Sync clearedForPatrol on roster entry based on stage
    if (board.cards[cardIdx].rosterId) {
      const roster = await readJson(rosterPath);
      const rIdx = roster.roster.findIndex((e) => e.id === board.cards[cardIdx].rosterId);
      if (rIdx !== -1) {
        roster.roster[rIdx].clearedForPatrol = payload.stage === "Cleared For Patrol";
        roster.roster[rIdx].updatedAt = new Date().toISOString();
        await writeJson(rosterPath, roster);
      }
    }

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
      canOnboard: false
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
    if (!user || (!user.canManageUsers && !user.canEditRoster && user.role !== "admin")) {
      send(res, 403, { error: "Forbidden" }); return;
    }
    const data = await readJson(bugsPath);
    send(res, 200, data);
    return;
  }

  if (req.method === "PUT" && url.pathname.match(/^\/api\/bugs\/[^/]+$/)) {
    if (!user || (!user.canManageUsers && !user.canEditRoster && user.role !== "admin")) {
      send(res, 403, { error: "Forbidden" }); return;
    }
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
  for (const file of ["roster.json", "users.json", "applications.json", "onboarding.json", "bugs.json"]) {
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

initDataDir().then(() => {
  server.listen(port, () => {
    console.log(`PD roster running at http://localhost:${port}`);
  });
});
