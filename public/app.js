// Populated from the API in loadRoster() — roster.json is the single source
// of truth for divisions/strikes, don't hardcode a duplicate list here.
let divisions = [];
let strikes = [];

let rosterData = { roster: [] };
let sessionUser = null;
let realSessionUser = null; // set when admin is previewing another role
let selectedEntryId = null;
let selectedApplicationId = null;
let currentReviewApplication = null;
let currentReviewReplay = {};
let showArchivedApplications = false;
let users = [];
let applications = [];
let onboardingCards = [];
let pendingTerminationId = null;
let pendingClearForPatrolId = null;
let promoteEntryId = null;
let activeCategoryFilter = "";
let entryListQuery = "";
// Rank list comes from GET /api/ranks (data/ranks.json) so Command can edit it
// without a deploy. Seeded empty and filled by loadRanks() before first render.
let rankList = [];
let discordState = { config: null, settings: { roleMap: [] } };

// ── Permission helpers ──
// One place per capability, mirroring the server's checks. Reviewing and
// accepting applications is onboarding work, not roster-editing work — gating
// it on canEditRoster is exactly the bug this fixes.
function canReviewApplications() {
  return Boolean(sessionUser?.canEditRoster || canOnboard());
}

function canOnboard() {
  return Boolean(sessionUser?.canOnboard || sessionUser?.role === "admin");
}

function canManageRanks() {
  return Boolean(sessionUser?.canManageRanks || sessionUser?.role === "admin");
}

// Mirrors ROLE_AUTHORITY on the server so the Users panel only offers actions
// the API will actually allow. The server is still the real guard.
const ROLE_AUTHORITY = { admin: 3, command: 2, supervisor: 1, onboarding: 1, viewer: 0 };

function authorityOf(user) {
  if (!user) return -1;
  if (user.role === "admin") return ROLE_AUTHORITY.admin;
  const base = ROLE_AUTHORITY[user.role || "viewer"] ?? 0;
  return user.canManageUsers ? Math.max(base, ROLE_AUTHORITY.command) : base;
}

function canActOnUser(target) {
  if (!sessionUser || !target) return false;
  if (sessionUser.id === target.id) return false;
  return authorityOf(target) < authorityOf(sessionUser);
}

// ── Application review signals ──
// Best-effort, informational-only signals for staff reviewing applications —
// none of this blocks submission or proves AI use, it just gives reviewers
// something to weigh. Browsers can't reveal what other tab/site a user went
// to, only that focus was lost and for how long.
const APPLICATION_ESSAY_FIELDS = ["roleplayPhilosophy", "characterDescription", "leoExperience", "bannedHistory", "clips"];
let pastedFields = new Set();
let pasteSamples = {};
let awayTracking = false;
let awayState = false;
let awayStartedAt = 0;
let awayCount = 0;
let awayTotalMs = 0;
let formStartedAt = 0;

function markAway() {
  if (!awayTracking || awayState) return;
  awayState = true;
  awayStartedAt = Date.now();
  awayCount += 1;
}

function markBack() {
  if (!awayTracking || !awayState) return;
  awayState = false;
  awayTotalMs += Date.now() - awayStartedAt;
}

// First 200 chars of whatever was pasted, so reviewers can tell a pasted
// link from a pasted essay.
function recordPasteSample(name, text) {
  pastedFields.add(name);
  const clean = String(text || "").trim();
  if (!clean) return;
  const list = pasteSamples[name] || (pasteSamples[name] = []);
  if (list.length >= 10) return;
  list.push(clean.slice(0, 200));
}

function resetApplicationSignals() {
  pastedFields = new Set();
  pasteSamples = {};
  awayTracking = false;
  awayState = false;
  awayCount = 0;
  awayTotalMs = 0;
  formStartedAt = 0;
  typingReplay = {};
  typingLastRecorded = {};
  typingLastValue = {};
  typingStartedAt = 0;
}

// Throttled snapshots per field, replayed later like a typing-history
// extension. Fixed-interval throttling would cap out after ~30s of
// continuous typing and cut a longer essay off mid-sentence, so the required
// gap grows with each snapshot recorded (dense at first, spreading out
// later) to cover a realistic ~10 minute writing session.
//
// Snapshots are delta-encoded as {t, k, s}: k = chars shared with the
// previous value, s = the rest. Typing mostly appends, so this stores about
// one copy of the essay in total rather than a full copy at every step.
const TYPING_BASE_THROTTLE_MS = 350;
const TYPING_THROTTLE_GROWTH = 1.06;
const TYPING_MAX_SNAPSHOTS = 120;
let typingReplay = {};
let typingLastRecorded = {};
let typingLastValue = {};
let typingStartedAt = 0;

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

function pushTypingSnapshot(name, value, overwriteLast = false) {
  const arr = typingReplay[name] || (typingReplay[name] = []);
  const previous = typingLastValue[name] || "";
  const k = commonPrefixLength(previous, value);
  const snapshot = { t: Date.now() - typingStartedAt, k, s: value.slice(k) };
  if (overwriteLast && arr.length) arr[arr.length - 1] = snapshot;
  else arr.push(snapshot);
  typingLastValue[name] = value;
}

function recordTypingSnapshot(name, value) {
  const now = Date.now();
  if (!typingStartedAt) typingStartedAt = now;
  const arr = typingReplay[name] || (typingReplay[name] = []);
  if (arr.length >= TYPING_MAX_SNAPSHOTS) return;
  const requiredGap = TYPING_BASE_THROTTLE_MS * (TYPING_THROTTLE_GROWTH ** arr.length);
  if (now - (typingLastRecorded[name] || 0) < requiredGap) return;
  typingLastRecorded[name] = now;
  pushTypingSnapshot(name, value);
}

// Called per essay field right before submitting — makes sure the replay's
// last frame always matches the real submitted answer, overwriting the
// final slot instead of appending once the cap is already reached.
function finalizeTypingSnapshot(name, value) {
  const arr = typingReplay[name];
  if (!arr || !arr.length || !value) return;
  if ((typingLastValue[name] || "") === value) return;
  pushTypingSnapshot(name, value, arr.length >= TYPING_MAX_SNAPSHOTS);
}

// Mirror of the server-side decoder — rebuilds full text at each step.
// Applications submitted before delta encoding shipped stored whole values as
// {t, v} rather than {t, k, s}. Decoding those with the delta path gave
// slice(0, NaN) + undefined — which is why replay on every older application
// rendered as the literal text "undefined". Fall back to the stored value.
function decodeTypingSnapshots(snapshots) {
  const values = [];
  let previous = "";
  for (const snap of snapshots) {
    if (typeof snap?.k !== "number" || typeof snap?.s !== "string") {
      previous = String(snap?.v ?? previous);
    } else {
      previous = previous.slice(0, Math.min(snap.k, previous.length)) + snap.s;
    }
    values.push({ t: Number(snap?.t) || 0, v: previous });
  }
  return values;
}

// Replaced by the list the board API serves (ONBOARDING_STAGES in server.js) —
// this is only the fallback for the first paint before that arrives.
let onboardingStages = [
  "Application Pending",
  "Application Accepted",
  "Interview Accepted",
  "Academy Scheduled",
  "Academy Passed",
  "Ride Alongs Completed",
  "Cleared For Patrol"
];

// Stages where a callsign gets assigned, and the rank that comes with it.
// Mirrors CALLSIGN_STAGES on the server.
const CALLSIGN_STAGES = {
  "Interview Accepted": "Recruit",
  "Academy Passed": "Probationary Officer"
};

// How long a card can sit in each stage before it decays (ms). null = no decay.
const STAGE_DECAY_MS = {
  "Application Pending":   48 * 3600 * 1000,
  "Application Accepted":  24 * 3600 * 1000,
  "Interview Accepted":    48 * 3600 * 1000,
  "Academy Scheduled":     72 * 3600 * 1000,
  "Academy Passed":        72 * 3600 * 1000,
  "Ride Alongs Completed": 72 * 3600 * 1000,
  "Cleared For Patrol":    null,
};

let decayTimerInterval = null;

// Derived from rankList (the API's flat, ordered rank array) rather than
// hardcoded — same single-source-of-truth rule divisions/strikes follow.
// A category's ranks don't have to be adjacent in the ladder: Lead Detective
// sits between Sergeant and Corporal but shares the Detective Bureau card
// with the detective ranks below Corporal. Category order follows the first
// appearance of each category in the ladder.
// Only canonical names go in here — aliases exist so old spellings already in
// roster.json ("Commisioner", "DCI Staff Sergeant") still land in the right
// category, but they must never show up as pickable options.
function buildRankCategories() {
  const byCategory = new Map();
  for (const rank of rankList) {
    const name = rank.category || "Other";
    if (!byCategory.has(name)) byCategory.set(name, { name, ranks: [] });
    byCategory.get(name).ranks.push(rank.name);
  }
  return [...byCategory.values()];
}

let rankCategories = [];

// Every selectable rank, highest first — what the rank pickers offer.
function allRankNames() {
  return rankList.map((rank) => rank.name);
}

async function loadRanks() {
  const data = await api("/api/ranks");
  rankList = data.ranks || [];
  rankCategories = buildRankCategories();
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function activeDivisions(entry) {
  return divisions.filter((division) => entry.divisions?.[division]);
}

function activeStrikes(entry) {
  return strikes.filter((strike) => entry.strikes?.[strike]);
}

function statusClass(activity) {
  return `status-${normalize(activity).replace(/\s+/g, "-") || "vacant"}`;
}

function cleanRank(rank) {
  return String(rank || "").replace(/\s+/g, " ").trim();
}

// Matches on canonical name or alias, so an entry still recorded under an old
// spelling keeps its category card instead of falling into "Other".
function categoryForRank(rank) {
  const cleaned = cleanRank(rank).toLowerCase();
  const match = rankList.find(
    (item) => cleanRank(item.name).toLowerCase() === cleaned ||
              (item.aliases || []).some((alias) => cleanRank(alias).toLowerCase() === cleaned)
  );
  return match?.category || "Other";
}

function groupedRoster(rows) {
  const buckets = new Map([...rankCategories.map((category) => [category.name, []]), ["Other", []]]);
  rows.forEach((entry) => {
    buckets.get(categoryForRank(entry.rank)).push(entry);
  });
  for (const entries of buckets.values()) {
    entries.sort((a, b) => {
      const na = parseInt(a.callsign, 10);
      const nb = parseInt(b.callsign, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a.callsign || "").localeCompare(String(b.callsign || ""));
    });
  }
  return [...buckets.entries()].filter(([, entries]) => entries.length);
}

function deduplicatedRoster() {
  const seen = new Map();
  for (const entry of rosterData.roster) {
    const cs = String(entry.callsign || "").trim();
    if (!cs) { seen.set(entry.id, entry); continue; }
    if (!seen.has(cs)) { seen.set(cs, entry); continue; }
    const prev = seen.get(cs);
    const prevVacant = prev.vacant || prev.activity === "Vacant" || !prev.name;
    const thisVacant = entry.vacant || entry.activity === "Vacant" || !entry.name;
    if (prevVacant && !thisVacant) seen.set(cs, entry); // prefer active
  }
  return [...seen.values()];
}

function filteredRoster() {
  const query = normalize($("#searchInput").value);
  const activity = $("#activityFilter").value;
  const rank = $("#rankFilter").value;
  const hideVacant = $("#hideVacantToggle")?.checked ?? true;
  return deduplicatedRoster().filter((entry) => {
    const isVacant = entry.vacant || entry.activity === "Vacant" || !entry.name;
    if (hideVacant && isVacant) return false;
    const haystack = normalize([
      entry.callsign,
      entry.name,
      entry.activity,
      entry.rank,
      categoryForRank(entry.rank),
      entry.notes,
      activeDivisions(entry).join(" ")
    ].join(" "));
    return (
      (!query || haystack.includes(query)) &&
      (!activity || entry.activity === activity) &&
      (!rank || entry.rank === rank) &&
      (!activeCategoryFilter || (categoryForRank(entry.rank) === activeCategoryFilter && entry.activity !== "Vacant" && !entry.vacant))
    );
  });
}

function renderSummary() {
  const entries = rosterData.roster;
  $("#departmentLabel").textContent = rosterData.department || "Police Department";
  $("#applicationHeading").textContent = `Apply to the ${rosterData.department || "department"}`;
  document.title = `${rosterData.department || "PD"} Roster`;
  $("#totalSlots").textContent = entries.length;
  $("#activeCount").textContent = entries.filter((entry) => entry.activity === "Active").length;
  $("#vacantCount").textContent = entries.filter((entry) => entry.activity === "Vacant" || entry.vacant).length;
  $("#inactiveCount").textContent = entries.filter((entry) => ["LOA", "Inactive", "Semi-Active"].includes(entry.activity)).length;
}

function renderFilters() {
  const currentActivity = $("#activityFilter").value;
  const currentRank = $("#rankFilter").value;
  const activities = [...new Set(rosterData.roster.map((entry) => entry.activity).filter(Boolean))].sort();
  const ranks = [...new Set(rosterData.roster.map((entry) => entry.rank).filter(Boolean))].sort();

  $("#activityFilter").innerHTML = `<option value="">All activity</option>${activities
    .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
    .join("")}`;
  $("#rankFilter").innerHTML = `<option value="">All ranks</option>${ranks
    .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
    .join("")}`;
  $("#activityFilter").value = currentActivity;
  $("#rankFilter").value = currentRank;
}

function renderRosterTable() {
  const rows = filteredRoster();
  $("#rosterBody").innerHTML = groupedRoster(rows)
    .map(([category, entries]) => {
      const filled = entries.filter((entry) => entry.activity !== "Vacant" && !entry.vacant).length;
      const categoryRow = `<tr class="category-row">
        <td colspan="9">
          <div>
            <strong>${escapeHtml(category)}</strong>
            <span>${entries.length} slots / ${filled} filled</span>
          </div>
        </td>
      </tr>`;
      const entryRows = entries
        .map((entry) => {
          const isVacant = entry.vacant || entry.activity === "Vacant";
          const divisionPills = isVacant ? [] : activeDivisions(entry);
          const strikePills = activeStrikes(entry);
          const tigDays = isVacant ? null : tigFromPromotionDate(entry.promotionDate);
          const tigDisplay = tigDays !== null ? formatTig(String(tigDays)) : "";
          return `<tr>
        <td>${escapeHtml(entry.callsign || "-")}</td>
        <td>${escapeHtml(entry.name || "Vacant")}${entry.clearedForPatrol ? `<span class="cleared-badge" title="Cleared for patrol">✓</span>` : ""}</td>
        <td>${isVacant ? "" : escapeHtml(entry.notes || "-")}</td>
        <td class="${statusClass(entry.activity)}">${escapeHtml(entry.activity || "Vacant")}</td>
        <td>${escapeHtml(entry.rank || "-")}</td>
        <td><span class="pill-row">${isVacant ? "" : renderPills(divisionPills)}</span></td>
        <td><span class="pill-row">${renderPills(strikePills.map((strike) => `Strike ${strike}`))}</span></td>
        <td>${escapeHtml(formatDate(entry.promotionDate))}</td>
        <td>${escapeHtml(tigDisplay)}</td>
      </tr>`;
        })
        .join("");
      return `${categoryRow}${entryRows}`;
    })
    .join("");
}

function renderPills(items) {
  if (!items.length) return `<span class="pill empty">None</span>`;
  return items.map((item) => `<span class="pill">${escapeHtml(item)}</span>`).join("");
}

function renderEntryList() {
  let rows = [...rosterData.roster];
  if (entryListQuery) {
    const q = normalize(entryListQuery);
    rows = rows.filter((entry) =>
      normalize([entry.callsign, entry.name, entry.rank, entry.activity].join(" ")).includes(q)
    );
  }

  // Group by rank category, preserving callsign sort within each group
  const grouped = groupedRoster(rows);

  if (!rows.length) {
    $("#entryList").innerHTML = `<div class="empty-state">No entries match.</div>`;
    return;
  }

  $("#entryList").innerHTML = grouped.map(([category, entries]) => {
    const items = entries.map((entry) => {
      const isVacant = entry.vacant || entry.activity === "Vacant" || !entry.name;
      return `<button class="mini-item ${entry.id === selectedEntryId ? "active" : ""}${isVacant ? " mini-item-vacant" : ""}" data-entry-id="${entry.id}">
        <strong>${escapeHtml(entry.callsign || "-")}</strong>
        <span>${escapeHtml(isVacant ? "Vacant" : (entry.name || "-"))}<br><small>${escapeHtml(entry.rank || "-")}</small></span>
        <small class="${isVacant ? "" : `status-${normalize(entry.activity)}`}">${escapeHtml(entry.activity || "Vacant")}</small>
      </button>`;
    }).join("");
    return `<div class="entry-list-group-header">${escapeHtml(category)}</div>${items}`;
  }).join("");
}

function renderCategoryOverview() {
  const entries = rosterData.roster;
  $("#categoryOverview").innerHTML = groupedRoster(entries)
    .map(([category, rows]) => {
      const filled = rows.filter((entry) => entry.activity !== "Vacant" && !entry.vacant).length;
      return `<button class="category-card" type="button" data-category-filter="${escapeHtml(category)}">
        <span>${escapeHtml(category)}</span>
        <strong>${filled}</strong>
        <small>${rows.length} slots</small>
      </button>`;
    })
    .join("");
}

function renderAll() {
  fillChecks();
  fillEntrySelects();
  renderSummary();
  renderCategoryOverview();
  renderFilters();
  renderRosterTable();
  renderEntryList();
}

function renderApplications() {
  const visible = applications.filter((a) => showArchivedApplications || !a.archived);
  const sorted = visible.sort((a, b) => {
    const order = { pending: 0, accepted: 1, rejected: 2 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(b.submittedAt).localeCompare(String(a.submittedAt));
  });
  const archivedCount = applications.filter((a) => a.archived).length;
  const archivedLabel = $("#archivedCountLabel");
  if (archivedLabel) archivedLabel.textContent = archivedCount ? `(${archivedCount})` : "";

  $("#applicationList").innerHTML = sorted.length
    ? sorted
        .map(
          (application) => `<button class="mini-item application-item ${application.id === selectedApplicationId ? "active" : ""}" data-application-id="${application.id}">
            <span><strong>${escapeHtml(application.name)}</strong>${application.archived ? ` <span class="archived-tag">archived</span>` : ""}<br><small>${escapeHtml(application.discord)}</small></span>
            <small>${escapeHtml(formatDate(application.submittedAt))}</small>
            <small class="${statusClass(application.status)}">${escapeHtml(application.status)}</small>
          </button>`
        )
        .join("")
    : `<div class="empty-state">${showArchivedApplications ? "No applications yet." : "No active applications."}</div>`;
}

function toDateInputValue(dateStr) {
  if (!dateStr || dateStr === "-" || dateStr === "N/A") return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}

function tigFromPromotionDate(promotionDate) {
  const iso = toDateInputValue(promotionDate);
  if (!iso) return null;
  const then = new Date(iso + "T00:00:00");
  if (isNaN(then.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((today - then) / 86400000));
}

function formatTig(value) {
  const days = parseInt(value, 10);
  if (isNaN(days) || value === "") return value || "-";
  if (days === 0) return "0D";
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const d = days % 30;
  const parts = [];
  if (years) parts.push(`${years}Y`);
  if (months) parts.push(`${months}M`);
  if (d) parts.push(`${d}D`);
  return parts.join(" ") || "0D";
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const activityOptions = ["Active", "LOA", "M-LOA", "Semi-Active", "Inactive", "Vacant"];

function fillChecks() {
  $("#divisionChecks").innerHTML = divisions
    .map((division) => `<label class="checkbox"><input type="checkbox" name="division_${division}"> ${division}</label>`)
    .join("");
  $("#strikeChecks").innerHTML = strikes
    .map((strike) => `<label class="checkbox"><input type="checkbox" name="strike_${strike}"> Strike ${strike}</label>`)
    .join("");
}

function fillEntrySelects() {
  // Activity dropdown
  $("#activityPicker").innerHTML = activityOptions
    .map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`)
    .join("");

  // Rank dropdown (grouped by category)
  $("#rankPicker").innerHTML = rankCategories
    .map(
      (cat) => `<optgroup label="${escapeHtml(cat.name)}">${cat.ranks
        .map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`)
        .join("")}</optgroup>`
    )
    .join("");

  // Callsign dropdown — populated by rank, see populateEntryCallsigns()
}

// `currentCallsign` is always offered as an option (so you can change rank
// without moving slots). `selectCallsign` is what's pre-selected — pass "" to
// force the user to choose, e.g. after changing rank.
function populateEntryCallsigns(rank, currentCallsign = "", selectCallsign = currentCallsign) {
  const picker = $("#callsignPicker");

  if (!rank) {
    picker.innerHTML = '<option value="">— Select a rank first —</option>';
    picker.disabled = true;
    return;
  }

  const slots = rosterData.roster.filter(
    (e) => (e.vacant || e.activity === "Vacant" || !e.name) && cleanRank(e.rank) === cleanRank(rank)
  );
  slots.sort((a, b) => {
    const na = parseInt(a.callsign, 10), nb = parseInt(b.callsign, 10);
    return (!isNaN(na) && !isNaN(nb)) ? na - nb : String(a.callsign).localeCompare(String(b.callsign));
  });

  const options = ['<option value="">— Select callsign —</option>'];
  // Always include the current callsign even if the slot is occupied (editing in place)
  const currentInSlots = slots.some((e) => String(e.callsign).trim() === String(currentCallsign).trim());
  if (currentCallsign && !currentInSlots) {
    options.push(`<option value="${escapeHtml(currentCallsign)}">${escapeHtml(currentCallsign)} (keep current slot)</option>`);
  }
  options.push(...slots.map((e) => `<option value="${escapeHtml(e.callsign)}">${escapeHtml(e.callsign)}</option>`));

  picker.innerHTML = options.join("");
  picker.disabled = false;
  picker.value = selectCallsign || "";
}

function entryToForm(entry) {
  const form = $("#entryForm");
  const fields = form.elements;
  fields.id.value = entry?.id || "";

  fields.name.value = entry?.name || "";
  fields.rank.value = entry?.rank || "";

  // Callsign — filtered to vacant slots matching rank, plus current callsign
  populateEntryCallsigns(entry?.rank || "", entry?.callsign || "");
  fields.activity.value = entry?.activity || "";
  fields.promotionDate.value = toDateInputValue(entry?.promotionDate || "");
  fields.notes.value = entry?.notes || "";
  fields.employeeNotes.value = entry?.employeeNotes || "";
  fields.vacant.checked = Boolean(entry?.vacant);
  fields.clearedForPatrol.checked = Boolean(entry?.clearedForPatrol);
  divisions.forEach((division) => {
    fields[`division_${division}`].checked = Boolean(entry?.divisions?.[division]);
  });
  strikes.forEach((strike) => {
    fields[`strike_${strike}`].checked = Boolean(entry?.strikes?.[strike]);
  });
  $("#entryFormTitle").textContent = entry ? `Edit ${entry.callsign || entry.name || "entry"}` : "New roster entry";
  $("#deleteEntryButton").disabled = !entry;
  $("#promoteEntryButton").disabled = !entry || !entry.name;

  // Rank + callsign are locked when editing an existing officer — use the
  // Promote / Reassign button to move someone. They stay editable for brand-new
  // entries (where you still need to assign an initial rank and slot).
  const editingExisting = Boolean(entry?.id);
  $("#rankPicker").disabled = editingExisting;
  if (editingExisting) {
    // Show the plain callsign (no "keep current slot" labelling) while locked
    $("#callsignPicker").innerHTML = `<option value="${escapeHtml(entry.callsign || "")}">${escapeHtml(entry.callsign || "—")}</option>`;
    $("#callsignPicker").disabled = true;
  }
  $("#rankCallsignHint").classList.toggle("hidden", !editingExisting);
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

const FIELD_LABELS = {
  roleplayPhilosophy: "RP Philosophy",
  characterDescription: "Character Description",
  leoExperience: "LEO Experience",
  bannedHistory: "Ban History",
  clips: "Clips"
};

// Chars appearing at once beyond what anyone types in a single interval —
// mirrors BURST_CHARS_THRESHOLD on the server.
const BURST_CHARS_THRESHOLD = 120;

// Informational only — none of this proves AI use or auto-rejects anything,
// it's just context for a human reviewer to weigh.
function collectApplicationSignals(application) {
  const signals = [];

  if (application.pastedFields?.length) {
    const labels = application.pastedFields.map((f) => FIELD_LABELS[f] || f);
    signals.push({ text: `Pasted into: ${labels.join(", ")}` });
  }

  Object.entries(application.pasteSamples || {}).forEach(([field, samples]) => {
    samples.forEach((sample) => {
      signals.push({ text: `Pasted into ${FIELD_LABELS[field] || field}: "${sample}${sample.length >= 200 ? "…" : ""}"`, muted: true });
    });
  });

  Object.entries(application.typingStats || {}).forEach(([field, stats]) => {
    const label = FIELD_LABELS[field] || field;
    if (stats.maxJumpChars >= BURST_CHARS_THRESHOLD) {
      signals.push({ text: `⚠ ${label}: ${stats.maxJumpChars} chars appeared at once (~${stats.maxJumpCps}/sec) — faster than typing`, warn: true });
    }
    if (stats.revisions === 0 && stats.finalLength > 200) {
      signals.push({ text: `⚠ ${label}: no edits or backspacing — text only ever grew`, warn: true });
    }
  });

  if (application.durationMs) {
    const chars = Object.values(application.typingStats || {}).reduce((sum, s) => sum + (s.finalLength || 0), 0);
    const rate = chars && application.durationMs ? Math.round(chars / (application.durationMs / 60000)) : 0;
    signals.push({ text: `Completed in ${formatDuration(application.durationMs)}${rate ? ` (~${rate} chars/min overall)` : ""}` });
  }

  if (application.awayCount) {
    const times = application.awayCount === 1 ? "time" : "times";
    signals.push({ text: `Left the tab ${application.awayCount} ${times} while applying (${formatDuration(application.awayTotalMs || 0)} total away)` });
  }

  (application.similarityFlags || []).forEach((flag) => {
    signals.push({
      text: `⚠ ${Math.round(flag.similarity * 100)}% text match with ${flag.applicantName || "another applicant"}'s application (${FIELD_LABELS[flag.field] || flag.field})`,
      warn: true,
      compare: flag
    });
  });

  return signals;
}

function renderApplicationSignals(application) {
  const signals = collectApplicationSignals(application);
  if (!signals.length) return "";
  return `<div class="app-detail-field app-detail-signals">
    <span class="app-detail-label">Review Signals</span>
    ${signals.map((s) => `<p class="app-detail-value">${escapeHtml(s.text)}</p>`).join("")}
  </div>`;
}

function buildReviewModalBody(application, replay) {
  const signals = collectApplicationSignals(application);
  const signalsHtml = signals.length
    ? `<div class="review-field app-detail-signals">
        <span class="review-field-label">Review Signals</span>
        ${signals.map((s) => `<p class="review-signal${s.warn ? " review-signal-warn" : ""}${s.muted ? " review-signal-muted" : ""}">${escapeHtml(s.text)}${
          s.compare ? ` <button type="button" class="replay-btn" data-compare-id="${escapeHtml(s.compare.applicationId)}" data-compare-field="${escapeHtml(s.compare.field)}">Compare side-by-side</button>` : ""
        }</p>`).join("")}
      </div>`
    : "";

  const fields = [
    { label: "Discord", value: application.discord },
    { label: "IRL Age", value: application.age },
    { label: "Faction Character", value: application.factionCharacter },
    { label: "RP Philosophy", value: application.roleplayPhilosophy, replay: "roleplayPhilosophy" },
    { label: "Character Description", value: application.characterDescription, replay: "characterDescription" },
    { label: "LEO Experience", value: application.leoExperience, replay: "leoExperience" },
    { label: "Ban History", value: application.bannedHistory, replay: "bannedHistory" },
    { label: "Clips", value: application.clips, replay: "clips" },
    { label: "Status", value: application.status !== "pending" ? application.status : null },
    { label: "Rejection Reason", value: application.rejectionReason },
    { label: "Rejection Notes", value: application.rejectionNotes }
  ].filter((f) => f.value);

  const fieldsHtml = fields.map((f) => {
    const snapshots = f.replay && replay?.[f.replay];
    const hasReplay = Array.isArray(snapshots) && snapshots.length > 1;
    return `<div class="review-field">
      <div class="review-field-header">
        <span class="review-field-label">${escapeHtml(f.label)}</span>
        ${hasReplay ? `<div class="replay-controls">
          <button type="button" class="replay-btn" data-replay-field="${escapeHtml(f.replay)}">▶ Replay</button>
          <select class="replay-speed" data-replay-speed="${escapeHtml(f.replay)}">
            <option value="1">1×</option>
            <option value="4" selected>4×</option>
            <option value="16">16×</option>
            <option value="0">Instant</option>
          </select>
          <input type="range" class="replay-scrub" data-replay-scrub="${escapeHtml(f.replay)}" min="0" max="${snapshots.length - 1}" value="${snapshots.length - 1}">
        </div>` : ""}
      </div>
      <p class="review-field-value">${escapeHtml(f.value)}</p>
      ${hasReplay ? `<div class="replay-display" data-replay-target="${escapeHtml(f.replay)}"></div>` : ""}
    </div>`;
  }).join("");

  return signalsHtml + fieldsHtml + renderNotesSection(application) + renderAuditSection(application);
}

function renderNotesSection(application) {
  const notes = application.notes || [];
  const list = notes.length
    ? notes.map((n) => `<div class="note-item">
        <div class="note-meta">${escapeHtml(n.author || n.authorEmail || "Unknown")} · ${escapeHtml(formatDateTime(n.createdAt))}</div>
        <div class="note-text">${escapeHtml(n.text)}</div>
      </div>`).join("")
    : `<p class="review-signal review-signal-muted">No notes yet.</p>`;
  return `<div class="review-field">
    <span class="review-field-label">Reviewer Notes (internal)</span>
    <div class="note-list">${list}</div>
    <div class="note-compose">
      <textarea id="noteInput" rows="2" placeholder="Add an internal note for other reviewers…"></textarea>
      <button type="button" id="addNoteBtn">Add note</button>
    </div>
  </div>`;
}

function renderAuditSection(application) {
  const log = application.auditLog || [];
  if (!log.length) return "";
  return `<div class="review-field">
    <span class="review-field-label">History</span>
    ${log.map((e) => `<p class="review-signal review-signal-muted">${escapeHtml(formatDateTime(e.at))} — ${escapeHtml(e.action)} by ${escapeHtml(e.by)}</p>`).join("")}
  </div>`;
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// ── Typing replay engine ──
// One replay runs at a time; starting another cancels the previous. Delays
// are clamped so a long thinking-pause doesn't stall playback for the same
// real duration, then divided by the chosen speed.
const replayControllers = new Map();

function stopAllReplays() {
  replayControllers.forEach((controller) => clearTimeout(controller.timer));
  replayControllers.clear();
}

function renderReplayFrame(field, index) {
  const values = currentReviewReplay[field];
  const display = document.querySelector(`[data-replay-target="${CSS.escape(field)}"]`);
  const scrub = document.querySelector(`[data-replay-scrub="${CSS.escape(field)}"]`);
  if (!display || !values) return;
  display.classList.add("active");
  const clamped = Math.max(0, Math.min(index, values.length - 1));
  display.innerHTML = `${escapeHtml(values[clamped].v)}<span class="replay-cursor">▍</span>`;
  if (scrub) scrub.value = String(clamped);
}

function playTypingReplay(field, startIndex = 0) {
  const values = currentReviewReplay[field];
  if (!values || values.length < 2) return;
  stopAllReplays();

  const button = document.querySelector(`[data-replay-field="${CSS.escape(field)}"]`);
  const speedEl = document.querySelector(`[data-replay-speed="${CSS.escape(field)}"]`);
  const speed = Number(speedEl?.value ?? 4);
  const controller = { timer: null, index: startIndex >= values.length - 1 ? 0 : startIndex };
  replayControllers.set(field, controller);
  if (button) button.textContent = "⏸ Pause";

  // Instant mode: jump straight to the end, no animation.
  if (speed === 0) {
    renderReplayFrame(field, values.length - 1);
    finishReplay(field);
    return;
  }

  function step() {
    renderReplayFrame(field, controller.index);
    if (controller.index >= values.length - 1) {
      finishReplay(field);
      return;
    }
    const gap = values[controller.index + 1].t - values[controller.index].t;
    const delay = Math.min(600, Math.max(30, gap)) / speed;
    controller.index += 1;
    controller.timer = setTimeout(step, delay);
  }
  step();
}

function finishReplay(field) {
  const controller = replayControllers.get(field);
  if (controller) clearTimeout(controller.timer);
  replayControllers.delete(field);
  const button = document.querySelector(`[data-replay-field="${CSS.escape(field)}"]`);
  if (button) button.textContent = "▶ Replay";
}

// ── Side-by-side comparison ──
// Highlights the words that are part of any shared 5-word run between the
// two answers, so a reported similarity percentage can be eyeballed rather
// than taken on trust.
function normalizeToken(token) {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sharedWordFlags(tokensA, tokensB, n = 5) {
  const normA = tokensA.map(normalizeToken);
  const normB = tokensB.map(normalizeToken);
  const shingles = new Set();
  for (let i = 0; i + n <= normB.length; i += 1) {
    shingles.add(normB.slice(i, i + n).join(" "));
  }
  const flags = new Array(tokensA.length).fill(false);
  for (let i = 0; i + n <= normA.length; i += 1) {
    if (shingles.has(normA.slice(i, i + n).join(" "))) {
      for (let j = i; j < i + n; j += 1) flags[j] = true;
    }
  }
  return flags;
}

function renderHighlighted(text, otherText) {
  const tokens = String(text || "").split(/(\s+)/);
  const words = tokens.filter((t) => !/^\s*$/.test(t));
  const otherWords = String(otherText || "").split(/\s+/).filter(Boolean);
  const flags = sharedWordFlags(words, otherWords);
  let wordIndex = 0;
  return tokens.map((token) => {
    if (/^\s*$/.test(token)) return escapeHtml(token);
    const marked = flags[wordIndex];
    wordIndex += 1;
    return marked ? `<mark>${escapeHtml(token)}</mark>` : escapeHtml(token);
  }).join("");
}

// Replay data is fetched per-application on demand rather than shipped with
// the whole inbox, so opening the modal is what pulls it.
async function openReviewModal() {
  if (!currentReviewApplication) return;
  currentReviewReplay = {};
  $("#reviewModal").classList.remove("hidden");
  $("#reviewModalTitle").textContent = `Review — ${currentReviewApplication.name}`;
  $("#reviewModalBody").innerHTML = `<p class="review-signal review-signal-muted">Loading…</p>`;

  if (currentReviewApplication.replayFields?.length) {
    try {
      const data = await api(`/api/applications/${encodeURIComponent(currentReviewApplication.id)}/replay`);
      currentReviewReplay = Object.fromEntries(
        Object.entries(data.typingReplay || {}).map(([field, snapshots]) => [field, decodeTypingSnapshots(snapshots)])
      );
    } catch {
      currentReviewReplay = {};
    }
  }
  renderReviewModal();
}

function renderReviewModal() {
  if (!currentReviewApplication) return;
  $("#reviewModalTitle").textContent = `Review — ${currentReviewApplication.name}`;
  $("#reviewModalBody").innerHTML = buildReviewModalBody(currentReviewApplication, currentReviewReplay);
  $("#archiveApplicationBtn").textContent = currentReviewApplication.archived ? "Restore" : "Archive";
  $("#archiveApplicationBtn").classList.remove("hidden");
  $("#deleteApplicationBtn").classList.toggle("hidden", !sessionUser?.canManageUsers);
}

function closeReviewModal() {
  stopAllReplays();
  $("#reviewModal").classList.add("hidden");
}

function openCompareView(field, otherApplication) {
  const current = currentReviewApplication;
  if (!current) return;
  const a = current[field] || "";
  const b = otherApplication?.[field] || "";
  const label = FIELD_LABELS[field] || field;
  $("#reviewModalTitle").textContent = `Compare — ${label}`;
  $("#reviewModalBody").innerHTML = `
    <button type="button" id="compareBackBtn" class="secondary">← Back to application</button>
    <p class="review-signal review-signal-muted">Highlighted text appears in both applications.</p>
    <div class="compare-grid">
      <div class="review-field">
        <span class="review-field-label">${escapeHtml(current.name)} (this application)</span>
        <p class="review-field-value">${renderHighlighted(a, b)}</p>
      </div>
      <div class="review-field">
        <span class="review-field-label">${escapeHtml(otherApplication?.name || "Other applicant")}</span>
        <p class="review-field-value">${b ? renderHighlighted(b, a) : "This application is no longer available (archived or deleted)."}</p>
      </div>
    </div>`;
}

function applicationToAcceptForm(application) {
  const form = $("#acceptApplicationForm");
  const fields = form.elements;
  selectedApplicationId = application?.id || null;
  currentReviewApplication = application || null;
  $("#expandReviewBtn").classList.toggle("hidden", !application);
  fields.applicationId.value = application?.id || "";
  fields.name.value = application?.name || "";
  $("#acceptFormTitle").textContent = application ? `Accept ${application.name}` : "Accept applicant";
  const appFields = [
    { label: "Age",                value: application?.age },
    { label: "Faction Character",  value: application?.factionCharacter },
    { label: "LEO Experience",     value: application?.leoExperience },
    { label: "Ban History",        value: application?.bannedHistory },
    { label: "Clips",              value: application?.clips },
    { label: "RP Philosophy",      value: application?.roleplayPhilosophy },
    { label: "Character Description", value: application?.characterDescription },
    { label: "Status",             value: application?.status !== "pending" ? application?.status : null },
    { label: "Rejection Reason",   value: application?.rejectionReason },
    { label: "Rejection Notes",    value: application?.rejectionNotes },
  ].filter((f) => f.value);
  $("#applicationDetail").innerHTML = application
    ? renderApplicationSignals(application) + appFields.map((f) =>
        `<div class="app-detail-field">
          <span class="app-detail-label">${escapeHtml(f.label)}</span>
          <p class="app-detail-value">${escapeHtml(String(f.value))}</p>
        </div>`
      ).join("")
    : `<p class="app-detail-empty">Select a pending application to review it.</p>`;
  $$("#acceptApplicationForm input, #acceptApplicationForm select, #acceptApplicationForm button").forEach((control) => {
    if (control.name === "name") return;
    // Review stays available after a decision so staff can re-check the
    // replay/signals on an already-accepted or rejected application.
    if (control.id === "expandReviewBtn") return;
    // Reviewing is an onboarding job, not a roster-edit job — gating this on
    // canEditRoster is what stopped onboarding-only staff accepting anyone
    // even though the server has always allowed it.
    control.disabled = !application || application.status !== "pending" || !canReviewApplications();
  });
  renderApplications();
}

function formToEntry() {
  const form = $("#entryForm");
  const fields = form.elements;
  return {
    id: fields.id.value,
    callsign: fields.callsign.value,
    name: fields.name.value,
    activity: fields.activity.value,
    rank: fields.rank.value,
    promotionDate: fields.promotionDate.value,
    notes: fields.notes.value,
    employeeNotes: fields.employeeNotes.value,
    vacant: fields.vacant.checked,
    clearedForPatrol: fields.clearedForPatrol.checked,
    divisions: Object.fromEntries(divisions.map((division) => [division, fields[`division_${division}`].checked])),
    strikes: Object.fromEntries(strikes.map((strike) => [strike, fields[`strike_${strike}`].checked]))
  };
}

const ROLE_PERMISSIONS = {
  viewer:     { canEditRoster: false, canManageUsers: false, canOnboard: false, canManageRanks: false },
  onboarding: { canEditRoster: false, canManageUsers: false, canOnboard: true,  canManageRanks: false },
  supervisor: { canEditRoster: true,  canManageUsers: false, canOnboard: false, canManageRanks: false },
  // Rank management is deliberately off for Command by default — it's granted
  // per account (High Command) rather than coming free with the role.
  command:    { canEditRoster: true,  canManageUsers: true,  canOnboard: true,  canManageRanks: false },
  admin:      { canEditRoster: true,  canManageUsers: true,  canOnboard: true,  canManageRanks: true  },
};

const ROLE_LABELS = {
  admin: "Admin", command: "Command Staff", supervisor: "Supervisor",
  onboarding: "Onboarding", viewer: "Viewer"
};

function activatePreview(role) {
  if (!role) { exitPreview(); return; }
  if (!realSessionUser) realSessionUser = sessionUser;
  const perms = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.viewer;
  sessionUser = { ...realSessionUser, role, ...perms };
  updatePreviewBanner();
  setDashboardState();
  showView("public");
}

function exitPreview() {
  if (realSessionUser) { sessionUser = realSessionUser; realSessionUser = null; }
  $("#previewRolePicker").value = "";
  updatePreviewBanner();
  setDashboardState();
}

function updatePreviewBanner() {
  const previewing = Boolean(realSessionUser);
  $("#previewBanner").classList.toggle("hidden", !previewing);
  if (previewing) $("#previewBannerRole").textContent = ROLE_LABELS[sessionUser.role] || sessionUser.role;
}

function setDashboardState() {
  const signedIn = Boolean(sessionUser);
  const isRealAdmin = realSessionUser?.role === "admin" || (!realSessionUser && sessionUser?.role === "admin");
  // Roster editors get the pipeline too — approving queued callsign
  // requests is their job, and the queue lives on that board.
  const canSeeOnboarding = canOnboard() || Boolean(sessionUser?.canEditRoster);
  const canSeeApplications = canReviewApplications();
  const canSeeDashboard = signedIn && (sessionUser?.canEditRoster || canSeeApplications);

  // Topbar auth area
  $("#signInBtn").classList.toggle("hidden", signedIn);
  $("#userPill").classList.toggle("hidden", !signedIn);
  if (signedIn) {
    $("#userPillName").textContent = sessionUser.name;
  }

  // Preview role picker — only for real admins, not while previewing
  $("#previewRolePicker").classList.toggle("hidden", !isRealAdmin || Boolean(realSessionUser));

  // Nav buttons — only show when signed in with appropriate access
  $("#dashboardNavBtn").classList.toggle("hidden", !canSeeDashboard);
  $("#onboardingNavBtn").classList.toggle("hidden", !canSeeOnboarding);

  // If signed out and currently on a protected view, redirect to public roster
  if (!signedIn) {
    const activeView = document.querySelector(".view:not(.hidden)");
    if (activeView?.id === "dashboardView" || activeView?.id === "onboardingView") {
      showView("public");
    }
    return;
  }

  const roleLabel = {
    admin: "Admin", command: "Command Staff", supervisor: "Supervisor",
    onboarding: "Onboarding", viewer: "Viewer"
  }[sessionUser.role] || sessionUser.role;
  $("#signedInAs").textContent = `${sessionUser.name} (${roleLabel})`;
  $("#userAdmin").classList.toggle("hidden", !sessionUser.canManageUsers);
  // Applications tab in onboarding view — show/hide based on permission
  $$(".onboarding-tab[data-tab='applications']").forEach((t) => t.classList.toggle("hidden", !canSeeApplications));
  const canSeeBugs = sessionUser.canEditRoster || sessionUser.canManageUsers;
  $("#bugReportsAdmin").classList.toggle("hidden", !canSeeBugs);
  // Hide roster entry editor for users who can't edit roster
  $("#entryForm").closest(".dashboard-grid").classList.toggle("hidden", !sessionUser.canEditRoster);
  $("#editNotice").textContent = sessionUser.canEditRoster
    ? "Changes save to data/roster.json immediately."
    : "Your account can view the dashboard but cannot edit roster entries.";
  $$("#entryForm input, #entryForm textarea, #entryForm select, #entryForm button").forEach((control) => {
    control.disabled = !sessionUser.canEditRoster;
  });
  $("#rankAdmin").classList.toggle("hidden", !canManageRanks());
  $("#discordAdmin").classList.toggle("hidden", !sessionUser.canManageUsers);
  $("#rosterAudit").classList.toggle("hidden", !sessionUser.canEditRoster);
}

async function loadRoster() {
  rosterData = await api("/api/roster");
  divisions = rosterData.divisions?.length
    ? rosterData.divisions
    : [...new Set(rosterData.roster.flatMap((entry) => Object.keys(entry.divisions || {})))];
  strikes = rosterData.strikes?.length
    ? rosterData.strikes
    : [...new Set(rosterData.roster.flatMap((entry) => Object.keys(entry.strikes || {})))];
  renderAll();
}

async function loadSession() {
  const data = await api("/api/session");
  sessionUser = data.user;
  setDashboardState();
  await loadPermittedData();
}

// Single place deciding which panels get data for the current permissions.
// Sign-in, boot, and role preview all go through here — they each used to
// keep their own copy of this list, and a panel added to one silently stayed
// empty in the others.
async function loadPermittedData() {
  if (!sessionUser) return;
  if (canReviewApplications()) await loadApplications();
  if (sessionUser.canManageUsers) await loadUsers();
  if (canOnboard() || sessionUser.canEditRoster) await loadOnboarding();
  if (sessionUser.canEditRoster || sessionUser.canManageUsers) await loadBugReports();
  if (canManageRanks()) renderRankManager();
  if (sessionUser.canManageUsers) await loadDiscordSettings();
  if (sessionUser.canEditRoster) await loadRosterAudit();
}

async function loadApplications() {
  const data = await api("/api/applications");
  applications = data.applications;
  renderApplications();
  const selected = applications.find((application) => application.id === selectedApplicationId);
  applicationToAcceptForm(selected || applications.find((application) => application.status === "pending") || null);
}

async function loadUsers() {
  const data = await api("/api/users");
  users = data.users;
  renderUsers();
}

let bugReports = [];

async function loadBugReports() {
  const data = await api("/api/bugs");
  bugReports = data.reports;
  renderBugReports();
}

function renderBugReports() {
  const el = $("#bugReportList");
  if (!bugReports.length) {
    el.innerHTML = `<div class="bug-item"><span class="bug-item-meta">No bug reports yet.</span></div>`;
    return;
  }
  el.innerHTML = bugReports.map((r) => {
    const date = new Date(r.submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const statusClass = r.status === "closed" ? "closed" : "open";
    return `<div class="bug-item">
      <div class="bug-item-header">
        <span class="bug-item-meta">${escapeHtml(r.section)} · ${escapeHtml(r.submittedBy)}${r.submittedEmail ? ` (${escapeHtml(r.submittedEmail)})` : ""} · ${date}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="bug-report-status ${statusClass}">${r.status}</span>
          ${r.status === "open"
            ? `<button class="bug-item-close" data-bug-id="${r.id}" data-action="close">Mark resolved</button>`
            : `<button class="bug-item-close" data-bug-id="${r.id}" data-action="reopen">Reopen</button>`}
        </div>
      </div>
      <div class="bug-item-desc">${escapeHtml(r.description)}</div>
    </div>`;
  }).join("");
}

function renderUsers() {
  const ROLE_ORDER = ["admin", "command", "supervisor", "onboarding", "viewer"];
  const ROLE_LABELS = { admin: "Admin", command: "Command Staff", supervisor: "Supervisor", onboarding: "Onboarding", viewer: "Officers / Civilians" };

  const groups = ROLE_ORDER.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    members: users.filter((u) => (u.role || "viewer") === role).sort((a, b) => a.name.localeCompare(b.name))
  })).filter((g) => g.members.length);

  $("#userList").innerHTML = groups.map((g) => `
    <div class="user-group-header">${escapeHtml(g.label)} <span class="user-group-count">${g.members.length}</span></div>
    ${g.members.map((user) => `<button class="mini-item" data-user-id="${user.id}">
        <span><strong>${escapeHtml(user.name)}</strong><br><small>${escapeHtml(user.email)}</small></span>
        <small>${user.canEditRoster ? "Roster edit" : "Read only"}${user.canManageUsers ? " + users" : ""}</small>
      </button>`).join("")}
  `).join("");
}

// ── Rank Manager ──
// Edits a working copy of the ladder; nothing reaches the server until Save.
let rankDraft = [];
let rankDraftDirty = false;

function markRankDraftDirty(dirty) {
  rankDraftDirty = dirty;
  $("#rankDirtyNotice").classList.toggle("hidden", !dirty);
}

function renderRankManager() {
  if (!canManageRanks()) return;
  if (!rankDraftDirty) rankDraft = rankList.map((rank) => ({ ...rank, aliases: [...(rank.aliases || [])] }));
  const inUse = new Map();
  for (const entry of rosterData.roster) {
    const name = cleanRank(entry.rank).toLowerCase();
    if (name) inUse.set(name, (inUse.get(name) || 0) + 1);
  }

  $("#rankManagerList").innerHTML = rankDraft.map((rank, index) => {
    const count = inUse.get(rank.name.toLowerCase()) || 0;
    return `<div class="rank-row" data-rank-index="${index}">
      <span class="rank-row-order">${index + 1}</span>
      <input class="rank-row-name" value="${escapeHtml(rank.name)}" data-rank-field="name" aria-label="Rank name">
      <input class="rank-row-category" value="${escapeHtml(rank.category)}" data-rank-field="category" list="rankCategoryOptions" aria-label="Category">
      <span class="rank-row-count" title="Roster entries at this rank">${count}</span>
      <span class="rank-row-actions">
        <button type="button" class="secondary" data-rank-move="up" ${index === 0 ? "disabled" : ""} aria-label="Move up">▲</button>
        <button type="button" class="secondary" data-rank-move="down" ${index === rankDraft.length - 1 ? "disabled" : ""} aria-label="Move down">▼</button>
        <button type="button" class="danger" data-rank-remove ${count ? "disabled" : ""} title="${count ? `${count} officer(s) still hold this rank` : "Remove"}">✕</button>
      </span>
    </div>`;
  }).join("");

  const categories = [...new Set(rankDraft.map((rank) => rank.category).filter(Boolean))];
  $("#rankCategoryOptions").innerHTML = categories
    .map((category) => `<option value="${escapeHtml(category)}"></option>`).join("");
}

async function saveRanks() {
  try {
    const data = await api("/api/ranks", {
      method: "PUT",
      body: JSON.stringify({ ranks: rankDraft })
    });
    rankList = data.ranks;
    rankCategories = buildRankCategories();
    markRankDraftDirty(false);
    renderRankManager();
    renderAll();
    toast("Rank list saved.");
  } catch (error) {
    toast(error.message);
  }
}

// ── Discord panel ──

async function loadDiscordSettings() {
  try {
    const [config, settings] = await Promise.all([
      api("/api/discord/config"),
      api("/api/discord/settings")
    ]);
    discordState = { config, settings };
  } catch {
    discordState = { config: null, settings: { roleMap: [] } };
  }
  renderDiscordPanel();
}

function renderDiscordPanel() {
  const config = discordState.config;
  const status = $("#discordStatus");
  if (!config) {
    status.innerHTML = `<p class="notice">Discord status unavailable.</p>`;
    return;
  }
  const light = (on, label, detail) =>
    `<div class="discord-light ${on ? "on" : "off"}">
      <span class="discord-light-dot"></span>
      <div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></div>
    </div>`;

  status.innerHTML = `
    <div class="discord-lights">
      ${light(config.oauthEnabled, "Account linking", config.oauthEnabled ? "Members can connect Discord" : "Set DISCORD_CLIENT_ID / SECRET / REDIRECT_URI")}
      ${light(config.roleSyncEnabled, "Role → permission sync", config.roleSyncEnabled ? "Mapped roles grant site permissions" : "Also needs DISCORD_GUILD_ID")}
      ${light(config.botEnabled, "Bot gateway", config.botEnabled ? "Watching rank changes" : "Set DISCORD_BOT_TOKEN to enable")}
      ${light(config.notifyEnabled, "Channel notifications", config.notifyEnabled ? "Posting rank changes" : "Needs the bot + DISCORD_NOTIFY_CHANNEL_ID")}
    </div>
    <p class="notice">
      Every Discord credential is read from the server environment. There is no
      field here — or anywhere in this dashboard — that can set or reveal a bot
      token, and no account, including admin, can change one from the site.
      ${config.linked
        ? `Your account is linked to <strong>${escapeHtml(config.linked.username || config.linked.id)}</strong>${
            config.linked.syncedAt ? ` — roles last read ${escapeHtml(new Date(config.linked.syncedAt).toLocaleString())}` : ""
          }.
           <button type="button" id="discordRefreshRolesBtn" class="link-btn">Refresh my roles</button>
           <button type="button" id="discordUnlinkBtn" class="link-btn">Unlink</button>`
        : config.oauthEnabled
          ? `<button type="button" id="discordLinkBtn" class="link-btn">Connect your Discord</button>`
          : ""}
    </p>
    ${config.roleSyncEnabled ? `<p class="notice">
      <button type="button" id="discordResyncBtn" class="secondary">Re-apply mapping to all linked accounts</button>
      Runs everyone's <em>stored</em> roles through the mapping above — use it after changing the mapping.
      It doesn't fetch fresh roles from Discord; without a bot only the member themselves can do that,
      with their own <strong>Refresh my roles</strong> button.
    </p>` : ""}`;

  const rows = discordState.settings.roleMap || [];
  $("#discordRoleMap").innerHTML = rows.length
    ? rows.map((row, index) => `
      <div class="discord-role-row" data-role-index="${index}">
        <div class="discord-role-head">
          <strong>${escapeHtml(row.label || "(unlabelled)")}</strong>
          <code>${escapeHtml(row.roleId)}</code>
          <button type="button" class="danger" data-role-remove aria-label="Remove mapping">✕</button>
        </div>
        <div class="discord-role-perms">
          <label class="checkbox"><input type="checkbox" data-role-perm="canEditRoster" ${row.permissions?.canEditRoster ? "checked" : ""}> Edit roster</label>
          <label class="checkbox"><input type="checkbox" data-role-perm="canManageUsers" ${row.permissions?.canManageUsers ? "checked" : ""}> Manage users</label>
          <label class="checkbox"><input type="checkbox" data-role-perm="canOnboard" ${row.permissions?.canOnboard ? "checked" : ""}> Onboard</label>
          <label class="checkbox"><input type="checkbox" data-role-perm="canManageRanks" ${row.permissions?.canManageRanks ? "checked" : ""}> Manage ranks</label>
          <span class="discord-role-rank">Rank: <strong>${escapeHtml(row.rank || "—")}</strong></span>
        </div>
      </div>`).join("")
    : `<p class="notice">No role mappings yet. Add a Discord role ID below to grant permissions automatically when someone links their account.</p>`;

  $("#addDiscordRoleForm").classList.remove("hidden");
  $("#saveDiscordBtn").classList.remove("hidden");
  $("#discordRankOptions").innerHTML = allRankNames()
    .map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
}

async function saveDiscordSettings() {
  try {
    const data = await api("/api/discord/settings", {
      method: "PUT",
      body: JSON.stringify({ roleMap: discordState.settings.roleMap })
    });
    discordState.settings = data;
    renderDiscordPanel();
    toast("Discord role mapping saved.");
  } catch (error) {
    toast(error.message);
  }
}

// ── Roster audit log ──

async function loadRosterAudit() {
  try {
    const data = await api("/api/roster/audit");
    renderRosterAudit(data.auditLog || []);
  } catch {
    renderRosterAudit([]);
  }
}

function renderRosterAudit(log) {
  if (!log.length) {
    $("#auditList").innerHTML = `<p class="notice">No roster changes recorded yet.</p>`;
    return;
  }
  $("#auditList").innerHTML = log.map((row) => {
    const when = new Date(row.at).toLocaleString();
    const changes = (row.changes || [])
      .map((change) => `<span class="audit-change">${escapeHtml(change.field)}: <s>${escapeHtml(change.from || "—")}</s> → <strong>${escapeHtml(change.to || "—")}</strong></span>`)
      .join("");
    return `<div class="audit-item">
      <div class="audit-item-head">
        <strong>${escapeHtml(row.callsign || "—")} ${escapeHtml(row.name || "")}</strong>
        <span class="audit-action">${escapeHtml(row.action)}</span>
      </div>
      <small class="audit-meta">${escapeHtml(row.byName || row.by)} · ${escapeHtml(when)}</small>
      ${changes ? `<div class="audit-changes">${changes}</div>` : ""}
    </div>`;
  }).join("");
}

async function loadOnboarding() {
  const data = await api("/api/onboarding");
  onboardingCards = data.cards;
  if (Array.isArray(data.stages) && data.stages.length) onboardingStages = data.stages;
  renderKanban();
  renderCallsignQueue();
}

function cardDecayInfo(card) {
  const limit = STAGE_DECAY_MS[card.stage];
  if (!limit) return null;
  const entered = card.stageEnteredAt || card.createdAt;
  if (!entered) return null;
  const elapsed = Date.now() - new Date(entered).getTime();
  const remaining = limit - elapsed;
  return { remaining, decayed: remaining <= 0 };
}

function formatCountdown(ms) {
  if (ms <= 0) return "OVERDUE";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return `${d}d ${rh}h left`;
  }
  return `${h}h ${m}m left`;
}

function updateDecayTimers() {
  $$(".kanban-card[data-card-id]").forEach((el) => {
    const card = onboardingCards.find((c) => c.id === el.dataset.cardId);
    if (!card) return;
    const info = cardDecayInfo(card);
    const timerEl = el.querySelector(".card-timer");
    if (!timerEl || !info) return;
    timerEl.textContent = formatCountdown(info.remaining);
    el.classList.toggle("kanban-card-decayed", info.decayed);
    timerEl.classList.toggle("card-timer-overdue", info.decayed);
  });
}

function renderKanban() {
  // Clear existing ticker
  if (decayTimerInterval) { clearInterval(decayTimerInterval); decayTimerInterval = null; }

  $("#kanbanBoard").innerHTML = onboardingStages
    .map((stage) => {
      const cards = onboardingCards.filter((c) => c.stage === stage);
      const isLast = stage === "Cleared For Patrol";
      return `<div class="kanban-col${isLast ? " kanban-col-final" : ""}">
        <div class="kanban-col-head">
          <span>${escapeHtml(stage)}</span>
          <span class="kanban-count">${cards.length}</span>
        </div>
        <div class="kanban-cards" data-stage="${escapeHtml(stage)}">
          ${cards
            .map((card) => {
              const info = cardDecayInfo(card);
              const decayed = info?.decayed ?? false;
              return `<div class="kanban-card${decayed ? " kanban-card-decayed" : ""}" draggable="true" data-card-id="${escapeHtml(card.id)}">
              <button type="button" class="kanban-card-move" data-move-card="${escapeHtml(card.id)}" aria-label="Move ${escapeHtml(card.name)} to another stage">⇄</button>
              <strong>${escapeHtml(card.name)}</strong>
              <small class="card-discord">${escapeHtml(card.discord)}</small>
              ${card.callsign || card.rank ? `<div class="card-meta">
                ${card.callsign ? `<span class="pill">${escapeHtml(card.callsign)}</span>` : ""}
                ${card.rank ? `<span class="pill">${escapeHtml(card.rank)}</span>` : ""}
              </div>` : ""}
              ${card.pendingCallsign ? `<div class="card-pending-callsign" title="Requested by ${escapeHtml(card.pendingCallsign.requestedBy || "")}">
                ⏳ Awaiting ${escapeHtml(card.pendingCallsign.rank || "")} callsign
              </div>` : ""}
              ${card.acceptedBy ? `<small class="card-accepted">👤 ${escapeHtml(card.acceptedBy)}</small>` : ""}
              ${info ? `<div class="card-timer${info.decayed ? " card-timer-overdue" : ""}">${formatCountdown(info.remaining)}</div>` : ""}
            </div>`;
            })
            .join("")}
        </div>
      </div>`;
    })
    .join("");

  // Live-update timers every 30s
  decayTimerInterval = setInterval(updateDecayTimers, 30000);

  // HTML5 drag-and-drop doesn't fire on touch devices at all, so the board was
  // unusable on a phone. This sheet is the touch path — same destinations, same
  // Academy Passed / Cleared For Patrol prompts, no dragging required.
  $$("[data-move-card]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openStagePicker(button.dataset.moveCard);
    });
  });

  // Drag events on cards
  $$(".kanban-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.cardId);
      card.classList.add("dragging");
      $("#terminateZone").classList.remove("hidden");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      $("#terminateZone").classList.add("hidden");
      $("#terminateZone").classList.remove("drag-over");
    });
  });

  // Drop zones
  $$(".kanban-cards").forEach((zone) => {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
      await requestStageMove(e.dataTransfer.getData("text/plain"), zone.dataset.stage);
    });
  });
}

// ── Callsign approval queue ──
// Onboarding staff can move a recruit into a callsign stage, but writing the
// callsign to the roster needs canEditRoster. The move queues a request here
// instead of failing, and a roster editor picks the actual callsign.

function pendingCallsignCards() {
  return onboardingCards.filter((card) => card.pendingCallsign);
}

function renderCallsignQueue() {
  const panel = $("#callsignQueue");
  if (!panel) return;
  const canApprove = Boolean(sessionUser?.canEditRoster);
  const queued = pendingCallsignCards();
  panel.classList.toggle("hidden", !canApprove);
  $("#callsignQueueCount").textContent = queued.length ? String(queued.length) : "";
  if (!canApprove) return;

  $("#callsignQueueList").innerHTML = queued.length
    ? queued.map((card) => {
        const requested = card.pendingCallsign;
        const when = requested.requestedAt ? new Date(requested.requestedAt).toLocaleString() : "";
        const free = vacantCallsignsForRank(requested.rank).length;
        return `<div class="queue-item" data-queue-card="${escapeHtml(card.id)}">
          <div class="queue-item-head">
            <strong>${escapeHtml(card.name)}</strong>
            <span class="pill">${escapeHtml(requested.rank || "")}</span>
          </div>
          <small class="queue-meta">
            ${escapeHtml(requested.stage || "")} · requested by ${escapeHtml(requested.requestedBy || "unknown")}${when ? ` · ${escapeHtml(when)}` : ""}
          </small>
          ${free ? "" : `<small class="queue-warning">No vacant ${escapeHtml(requested.rank || "")} slots — free one up first.</small>`}
          <div class="button-row">
            <button type="button" data-queue-approve ${free ? "" : "disabled"}>Assign callsign</button>
            <button type="button" class="secondary" data-queue-decline>Decline</button>
          </div>
        </div>`;
      }).join("")
    : `<p class="notice">No callsign requests waiting.</p>`;
}

function vacantCallsignsForRank(rank) {
  return rosterData.roster.filter(
    (entry) => (entry.vacant || entry.activity === "Vacant") && cleanRank(entry.rank) === cleanRank(rank)
  );
}

// Stage picker used by the touch path. Routes through requestStageMove so the
// Academy Passed and Cleared For Patrol prompts behave identically whether the
// card was dragged or tapped.
function openStagePicker(cardId) {
  const card = onboardingCards.find((item) => item.id === cardId);
  if (!card) return;
  $("#stagePickerName").textContent = card.name || "this recruit";
  $("#stagePickerOptions").innerHTML = onboardingStages
    .map((stage) => `<button type="button" class="stage-option${stage === card.stage ? " current" : ""}"
        data-stage-target="${escapeHtml(stage)}" ${stage === card.stage ? "disabled" : ""}>
        ${escapeHtml(stage)}${stage === card.stage ? " (current)" : ""}
      </button>`)
    .join("") +
    `<button type="button" class="stage-option danger" data-stage-target="__terminate__">Terminate employee</button>`;
  $("#stagePickerModal").dataset.cardId = cardId;
  $("#stagePickerModal").classList.remove("hidden");
}

// Shared by drag-drop and the stage picker.
async function requestStageMove(cardId, targetStage) {
  const card = onboardingCards.find((item) => item.id === cardId);
  if (!card || card.stage === targetStage) return;

  // Stages that need a callsign: a roster editor picks one now, anyone else
  // moves the card and leaves a request in the approval queue.
  if (CALLSIGN_STAGES[targetStage]) {
    if (sessionUser?.canEditRoster) {
      openCallsignModal({ cardId, stage: targetStage, mode: "move" });
    } else {
      await moveOnboardingCard(cardId, targetStage, {},
        "Moved — a callsign request is now waiting for roster staff.");
    }
    return;
  }

  if (targetStage === "Cleared For Patrol") {
    pendingClearForPatrolId = cardId;
    $("#clearForPatrolName").textContent = card.name || "this recruit";
    $("#clearForPatrolModal").classList.remove("hidden");
    return;
  }

  await moveOnboardingCard(cardId, targetStage);
}

// Returns true only when the move actually landed — callers add their own
// follow-up message, and a failed move must not be reported as a success.
async function moveOnboardingCard(cardId, stage, extra = {}, message = null) {
  try {
    await api(`/api/onboarding/${encodeURIComponent(cardId)}`, {
      method: "PUT",
      body: JSON.stringify({ stage, ...extra })
    });
    // Always reload both so roster badges (clearedForPatrol, rank, etc.) stay in sync
    await Promise.all([loadOnboarding(), loadRoster()]);
    toast(message || `Moved to "${stage}"`);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

// ── Callsign modal ──
// One modal for every path that puts someone in a callsign: a roster editor
// moving a card into Interview Accepted or Academy Passed, and approving a
// request that onboarding staff queued.
let callsignModalState = null;

function openCallsignModal({ cardId, stage, mode }) {
  const card = onboardingCards.find((item) => item.id === cardId);
  if (!card) return;
  const defaultRank = card.pendingCallsign?.rank || CALLSIGN_STAGES[stage] || "Recruit";
  callsignModalState = { cardId, stage, mode };

  $("#callsignModalTitle").textContent = mode === "approve"
    ? `Assign callsign — ${card.name}`
    : `${stage} — ${card.name}`;
  $("#callsignModalBlurb").textContent = mode === "approve"
    ? `Requested by ${card.pendingCallsign?.requestedBy || "onboarding"}. Assigning writes their roster entry immediately.`
    : "Pick a rank and a vacant callsign. The roster updates immediately.";
  $("#callsignConfirmBtn").textContent = mode === "approve" ? "Approve & assign" : "Assign";

  $("#callsignModalRank").innerHTML = rankCategories
    .map(
      (cat) => `<optgroup label="${escapeHtml(cat.name)}">${cat.ranks
        .map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`)
        .join("")}</optgroup>`
    )
    .join("");
  // Fall back to whatever's first if the expected rank was renamed or removed
  // in the Rank Manager — otherwise the picker silently shows a blank value.
  $("#callsignModalRank").value = defaultRank;
  if (!$("#callsignModalRank").value) $("#callsignModalRank").selectedIndex = 0;
  populateCallsignModalOptions($("#callsignModalRank").value);
  // Without this a roster editor can't move anyone into a callsign stage while
  // every slot for that rank is full — cancel is the only way out, and the
  // card is stuck. Queueing leaves the request for whoever frees a slot.
  $("#callsignQueueBtn").classList.toggle("hidden", mode !== "move");
  $("#callsignModal").classList.remove("hidden");
}

function closeCallsignModal() {
  callsignModalState = null;
  $("#callsignModal").classList.add("hidden");
}

function populateCallsignModalOptions(rank) {
  const picker = $("#callsignModalCallsign");
  const vacant = vacantCallsignsForRank(rank);
  picker.innerHTML = vacant.length
    ? [
        `<option value="">— Select callsign —</option>`,
        ...vacant.map((e) => `<option value="${escapeHtml(e.callsign)}">${escapeHtml(e.callsign)}</option>`)
      ].join("")
    : `<option value="">No vacant slots for this rank</option>`;
}

// ── Promote / Reassign flow ──
// Opens a dedicated modal to move an officer to a new rank + vacant callsign.
// The server vacates their old slot automatically (see PUT /api/roster swap).
function openPromoteModal() {
  const entry = rosterData.roster.find((e) => e.id === selectedEntryId);
  if (!entry) { toast("Select an officer first."); return; }
  if (!entry.name) { toast("This slot is vacant — there's no officer to promote."); return; }
  promoteEntryId = entry.id;
  $("#promoteOfficerName").textContent = entry.name;
  $("#promoteCurrentSlot").textContent = `${entry.callsign || "—"} · ${entry.rank || "—"}`;
  $("#promoteRankPicker").innerHTML = rankCategories
    .map(
      (cat) => `<optgroup label="${escapeHtml(cat.name)}">${cat.ranks
        .map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`)
        .join("")}</optgroup>`
    )
    .join("");
  if (entry.rank) $("#promoteRankPicker").value = entry.rank;
  populatePromoteCallsigns($("#promoteRankPicker").value, entry.callsign || "");
  $("#promoteModal").classList.remove("hidden");
}

function populatePromoteCallsigns(rank, currentCallsign = "") {
  const picker = $("#promoteCallsignPicker");
  const vacant = rosterData.roster.filter(
    (e) => (e.vacant || e.activity === "Vacant") && cleanRank(e.rank) === cleanRank(rank)
  );
  const options = [`<option value="">— Select callsign —</option>`];
  // Allow promoting in place (rank change without moving slots)
  if (currentCallsign) {
    options.push(`<option value="${escapeHtml(currentCallsign)}">${escapeHtml(currentCallsign)} (keep current slot)</option>`);
  }
  options.push(...vacant.map((e) => `<option value="${escapeHtml(e.callsign)}">${escapeHtml(e.callsign)}</option>`));
  picker.innerHTML = options.join("");
  picker.value = "";
}

function userToForm(user = {}) {
  const form = $("#userForm");
  const fields = form.elements;
  fields.id.value = user.id || "";
  fields.name.value = user.name || "";
  fields.email.value = user.email || "";
  fields.password.value = "";
  fields.role.value = user.role || "viewer";
  fields.canEditRoster.checked = Boolean(user.canEditRoster);
  fields.canManageUsers.checked = Boolean(user.canManageUsers);
  fields.canOnboard.checked = Boolean(user.canOnboard);
  fields.canManageRanks.checked = Boolean(user.canManageRanks);

  // Mirror the server's authority ladder: an existing account at or above your
  // own level is read-only here, and your own permissions are never editable.
  const existing = user.id ? user : null;
  const isSelf = existing && sessionUser?.id === existing.id;
  const locked = Boolean(existing) && !canActOnUser(existing);
  const notice = $("#userFormNotice");
  notice.classList.toggle("hidden", !locked && !isSelf);
  if (isSelf) {
    notice.textContent = "This is your own account — you can change your name, email, and password, but not your own permissions.";
  } else if (locked) {
    notice.textContent = "This account is at or above your permission level. You can't edit or remove it.";
  }

  for (const name of ["role", "canEditRoster", "canManageUsers", "canOnboard", "canManageRanks"]) {
    fields[name].disabled = locked || isSelf;
  }
  // Mirrors ungrantableFlag() on the server: you can't tick a permission you
  // don't hold yourself, unless the account already has it (so you can still
  // untick it). Rank management is the one this matters for — it's per
  // account rather than part of the Command role.
  const isAdmin = sessionUser?.role === "admin";
  for (const flag of ["canEditRoster", "canManageUsers", "canOnboard", "canManageRanks"]) {
    if (fields[flag].disabled) continue;
    let reason = "";
    if (!sessionUser?.[flag] && !isAdmin && !existing?.[flag]) {
      reason = "You don't have this permission, so you can't grant it.";
    } else if (flag === "canManageUsers" && !isAdmin && !existing?.[flag]) {
      // Granting manage-users puts them on the Command rung, which is the
      // highest rung below admin — so only an admin outranks the result.
      reason = "Only an admin can grant user management.";
    }
    fields[flag].disabled = Boolean(reason);
    fields[flag].closest(".checkbox").title = reason;
  }
  for (const name of ["name", "email", "password"]) {
    fields[name].disabled = locked;
  }
  $("#deleteUserButton").classList.toggle("hidden", !existing || locked);
}

function switchApplyTab(tab) {
  $$(".apply-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#applyTabContent").classList.toggle("hidden", tab !== "apply");
  $("#statusTabContent").classList.toggle("hidden", tab !== "status");
}

const statusMessages = {
  pending: "Your application is under review by command staff. We'll be in touch via Discord.",
  accepted: `Congratulations — your application has been accepted!<br><br>
<strong>Your next steps:</strong><br>
1. Join the <strong>LSPD Discord</strong> server: <a href="https://discord.gg/ZVNmN7qyGy" target="_blank" rel="noopener" style="color:var(--gold)">discord.gg/ZVNmN7qyGy</a><br>
2. Open a <strong>ticket</strong> to schedule your academy.<br>
3. Include a <strong>screenshot of this approved status page</strong> in your ticket so staff can verify your application.`,
};

const statusColors = { pending: "var(--gold)", accepted: "var(--green)", rejected: "var(--red)" };

function showApplicationStatus(application) {
  $("#statusName").textContent = application.name;
  $("#statusBadge").textContent = application.status.charAt(0).toUpperCase() + application.status.slice(1);
  $("#statusBadge").style.color = statusColors[application.status] || "";

  let message = statusMessages[application.status] || "";
  if (application.status === "rejected") {
    message = "Your application was not accepted at this time. You're welcome to reapply in the future.";
    if (application.rejectionReason) {
      message += `<br><br><strong>Reason:</strong> ${escapeHtml(application.rejectionReason)}`;
    }
    if (application.rejectionNotes) {
      message += `<br><strong>Additional notes:</strong> ${escapeHtml(application.rejectionNotes)}`;
    }
  }
  $("#statusMessage").innerHTML = message;

  $("#statusDate").textContent = `Submitted ${formatDate(application.submittedAt)}` +
    (application.reviewedAt ? `  ·  Reviewed ${formatDate(application.reviewedAt)}` : "");
  $("#applicationStatusPanel").classList.remove("hidden");
  $("#noApplicationMessage").classList.add("hidden");
  switchApplyTab("status");
}

async function checkSavedApplicationStatus() {
  const id = localStorage.getItem("pd_application_id");
  if (!id) return;
  try {
    const application = await api(`/api/applications/status?id=${encodeURIComponent(id)}`);
    showApplicationStatus(application);
  } catch {
    localStorage.removeItem("pd_application_id");
  }
}

function closeMobileNav() {
  const nav = $(".nav");
  const btn = $("#hamburgerBtn");
  if (nav) nav.classList.remove("mobile-open");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function showView(view) {
  $$(".nav-button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  $("#publicView").classList.toggle("hidden", view !== "public");
  $("#applyView").classList.toggle("hidden", view !== "apply");
  $("#dashboardView").classList.toggle("hidden", view !== "dashboard");
  $("#onboardingView").classList.toggle("hidden", view !== "onboarding");
  if (view === "onboarding" && (canOnboard() || sessionUser?.canEditRoster)) {
    loadOnboarding();
    if (canReviewApplications()) loadApplications();
  }
  closeMobileNav();
  // Keep the URL hash in sync so refresh stays on the current tab
  const hash = view === "public" ? "" : `#${view}`;
  history.replaceState(null, "", hash || location.pathname + location.search);
}

function wireEvents() {
  // Terminate drop zone is a static element (unlike the kanban cards/columns,
  // which are recreated on every renderKanban() call) — wire it once here
  // instead of inside renderKanban(), or listeners pile up on every refresh.
  const terminateZone = $("#terminateZone");
  terminateZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    terminateZone.classList.add("drag-over");
  });
  terminateZone.addEventListener("dragleave", () => terminateZone.classList.remove("drag-over"));
  terminateZone.addEventListener("drop", (e) => {
    e.preventDefault();
    terminateZone.classList.remove("drag-over");
    terminateZone.classList.add("hidden");
    const cardId = e.dataTransfer.getData("text/plain");
    const card = onboardingCards.find((c) => c.id === cardId);
    if (!card) return;
    pendingTerminationId = cardId;
    $("#terminateName").textContent = card.name;
    $("#terminateModal").classList.remove("hidden");
  });

  const stagePicker = $("#stagePickerModal");
  const closeStagePicker = () => {
    stagePicker.classList.add("hidden");
    delete stagePicker.dataset.cardId;
  };
  $("#stagePickerCancelBtn").addEventListener("click", closeStagePicker);
  stagePicker.addEventListener("click", (event) => {
    if (event.target === stagePicker) closeStagePicker();
  });
  $("#stagePickerOptions").addEventListener("click", async (event) => {
    const option = event.target.closest("[data-stage-target]");
    if (!option) return;
    const cardId = stagePicker.dataset.cardId;
    const target = option.dataset.stageTarget;
    closeStagePicker();
    if (!cardId) return;
    if (target === "__terminate__") {
      const card = onboardingCards.find((item) => item.id === cardId);
      if (!card) return;
      pendingTerminationId = cardId;
      $("#terminateName").textContent = card.name;
      $("#terminateModal").classList.remove("hidden");
      return;
    }
    await requestStageMove(cardId, target);
  });

  $$(".apply-tab").forEach((button) => {
    button.addEventListener("click", () => switchApplyTab(button.dataset.tab));
  });

  $$(".nav-button").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });

  $("#hamburgerBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const nav = $(".nav");
    const isOpen = nav.classList.toggle("mobile-open");
    $("#hamburgerBtn").setAttribute("aria-expanded", String(isOpen));
  });

  document.addEventListener("click", (e) => {
    if (!$(".nav").classList.contains("mobile-open")) return;
    if (!$(".nav").contains(e.target) && e.target !== $("#hamburgerBtn")) {
      closeMobileNav();
    }
  });

  $("#refreshOnboardingBtn").addEventListener("click", () => {
    const activeTab = document.querySelector(".onboarding-tab.active")?.dataset.tab;
    if (activeTab === "applications") loadApplications();
    else loadOnboarding();
  });

  // Onboarding tab switcher
  $$(".onboarding-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".onboarding-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const isPipeline = tab.dataset.tab === "pipeline";
      $("#pipelineTab").classList.toggle("hidden", !isPipeline);
      $("#applicationsTab").classList.toggle("hidden", isPipeline);
      $("#onboardingHeading").textContent = isPipeline ? "Recruit Pipeline" : "Application Inbox";
      if (!isPipeline) loadApplications();
    });
  });

  $("#callsignModalRank").addEventListener("change", () => {
    populateCallsignModalOptions($("#callsignModalRank").value);
  });

  $("#callsignConfirmBtn").addEventListener("click", async () => {
    if (!callsignModalState) return;
    const callsign = $("#callsignModalCallsign").value;
    if (!callsign) { toast("Please select a callsign."); return; }
    const rank = $("#callsignModalRank").value;
    const { cardId, stage, mode } = callsignModalState;
    const button = $("#callsignConfirmBtn");
    button.disabled = true;
    try {
      if (mode === "approve") {
        // The card is already in the stage — this only fills in the callsign.
        await api(`/api/onboarding/${encodeURIComponent(cardId)}/callsign`, {
          method: "POST",
          body: JSON.stringify({ callsign, rank })
        });
        await Promise.all([loadOnboarding(), loadRoster()]);
        toast(`Assigned ${callsign}.`);
      } else if (!await moveOnboardingCard(cardId, stage, { callsign, rank })) {
        // Callsign taken since the picker was built, say — keep the modal up
        // so they can choose another instead of starting the move again.
        populateCallsignModalOptions(rank);
        return;
      }
      closeCallsignModal();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("#callsignQueueBtn").addEventListener("click", async () => {
    if (!callsignModalState) return;
    const { cardId, stage } = callsignModalState;
    const rank = $("#callsignModalRank").value;
    closeCallsignModal();
    // No callsign in the payload, so the server queues it like any other
    // move by someone who can't assign one.
    await moveOnboardingCard(cardId, stage, { rank }, "Moved — callsign request left in the queue.");
  });

  $("#callsignCancelBtn").addEventListener("click", closeCallsignModal);

  $("#callsignQueueList").addEventListener("click", async (event) => {
    const item = event.target.closest("[data-queue-card]");
    if (!item) return;
    const cardId = item.dataset.queueCard;
    if (event.target.closest("[data-queue-approve]")) {
      const card = onboardingCards.find((entry) => entry.id === cardId);
      openCallsignModal({ cardId, stage: card?.pendingCallsign?.stage || card?.stage, mode: "approve" });
      return;
    }
    if (event.target.closest("[data-queue-decline]")) {
      const card = onboardingCards.find((entry) => entry.id === cardId);
      if (!confirm(`Decline the callsign request for ${card?.name || "this recruit"}? They stay in ${card?.stage || "this stage"} with no callsign.`)) return;
      try {
        await api(`/api/onboarding/${encodeURIComponent(cardId)}/callsign`, { method: "DELETE" });
        await loadOnboarding();
        toast("Request declined.");
      } catch (error) {
        toast(error.message);
      }
    }
  });

  // ── Promote / Reassign modal ──
  $("#promoteEntryButton").addEventListener("click", openPromoteModal);

  $("#promoteRankPicker").addEventListener("change", () => {
    const entry = rosterData.roster.find((e) => e.id === promoteEntryId);
    populatePromoteCallsigns($("#promoteRankPicker").value, entry?.callsign || "");
  });

  $("#promoteConfirmBtn").addEventListener("click", async () => {
    const entry = rosterData.roster.find((e) => e.id === promoteEntryId);
    if (!entry) return;
    const newRank = $("#promoteRankPicker").value;
    const newCallsign = $("#promoteCallsignPicker").value;
    if (!newCallsign) { toast("Please select a callsign."); return; }
    const confirmBtn = $("#promoteConfirmBtn");
    confirmBtn.disabled = true;
    try {
      const saved = await api(`/api/roster/${encodeURIComponent(entry.id)}`, {
        method: "PUT",
        body: JSON.stringify({ ...entry, rank: newRank, callsign: newCallsign })
      });
      await loadRoster();
      selectedEntryId = saved.id;
      entryToForm(saved);
      renderEntryList();
      promoteEntryId = null;
      $("#promoteModal").classList.add("hidden");
      toast(`${entry.name} reassigned to ${newCallsign} (${newRank}).`);
    } catch (err) {
      toast(err.message);
    } finally {
      confirmBtn.disabled = false;
    }
  });

  $("#promoteCancelBtn").addEventListener("click", () => {
    promoteEntryId = null;
    $("#promoteModal").classList.add("hidden");
  });

  $("#promoteModal").addEventListener("click", (e) => {
    if (e.target === $("#promoteModal")) {
      promoteEntryId = null;
      $("#promoteModal").classList.add("hidden");
    }
  });

  $("#callsignModal").addEventListener("click", (e) => {
    if (e.target === $("#callsignModal")) closeCallsignModal();
  });

  $("#terminateConfirmBtn").addEventListener("click", async () => {
    if (!pendingTerminationId) return;
    const id = pendingTerminationId;
    pendingTerminationId = null;
    $("#terminateModal").classList.add("hidden");
    try {
      await api(`/api/onboarding/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadRoster();
      await loadOnboarding();
      if (canReviewApplications()) await loadApplications();
      toast("Employee terminated and removed from roster.");
    } catch (err) {
      toast(err.message);
    }
  });

  $("#terminateCancelBtn").addEventListener("click", () => {
    pendingTerminationId = null;
    $("#terminateModal").classList.add("hidden");
  });

  $("#terminateModal").addEventListener("click", (e) => {
    if (e.target === $("#terminateModal")) {
      pendingTerminationId = null;
      $("#terminateModal").classList.add("hidden");
    }
  });

  $("#clearForPatrolConfirmBtn").addEventListener("click", async () => {
    if (!pendingClearForPatrolId) return;
    const id = pendingClearForPatrolId;
    pendingClearForPatrolId = null;
    $("#clearForPatrolModal").classList.add("hidden");
    await moveOnboardingCard(id, "Cleared For Patrol");
  });

  $("#clearForPatrolCancelBtn").addEventListener("click", () => {
    pendingClearForPatrolId = null;
    $("#clearForPatrolModal").classList.add("hidden");
  });

  $("#clearForPatrolModal").addEventListener("click", (e) => {
    if (e.target === $("#clearForPatrolModal")) {
      pendingClearForPatrolId = null;
      $("#clearForPatrolModal").classList.add("hidden");
    }
  });

  $("#applyAgainButton").addEventListener("click", () => {
    localStorage.removeItem("pd_application_id");
    $("#applicationStatusPanel").classList.add("hidden");
    $("#noApplicationMessage").classList.remove("hidden");
    resetApplicationSignals();
    switchApplyTab("apply");
  });

  $("#discordLookupButton").addEventListener("click", async () => {
    const discord = $("#discordLookupInput").value.trim();
    if (!discord) return;
    try {
      const application = await api(`/api/applications/status?discord=${encodeURIComponent(discord)}`);
      localStorage.setItem("pd_application_id", application.id || "");
      showApplicationStatus(application);
      $("#discordLookupResult").textContent = "";
    } catch {
      $("#discordLookupResult").textContent = "No application found for that Discord username.";
    }
  });

  $("#discordLookupInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#discordLookupButton").click();
  });

  $("#applicationForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = form.elements;
    const submitBtn = form.querySelector("[type=submit]");
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    APPLICATION_ESSAY_FIELDS.forEach((name) => finalizeTypingSnapshot(name, fields[name].value));
    try {
      const next = await api("/api/applications", {
        method: "POST",
        body: JSON.stringify({
          name: fields.name.value,
          discord: fields.discord.value,
          age: fields.age.value,
          factionCharacter: fields.factionCharacter.value,
          roleplayPhilosophy: fields.roleplayPhilosophy.value,
          characterDescription: fields.characterDescription.value,
          leoExperience: fields.leoExperience.value,
          bannedHistory: fields.bannedHistory.value,
          clips: fields.clips.value,
          pastedFields: [...pastedFields],
          pasteSamples,
          awayCount,
          awayTotalMs,
          durationMs: formStartedAt ? Date.now() - formStartedAt : 0,
          typingReplay
        })
      });
      localStorage.setItem("pd_application_id", next.application.id);
      form.reset();
      updateSubmitState();
      resetApplicationSignals();
      showApplicationStatus(next.application);
      if (canReviewApplications()) await loadApplications();
      toast("Application submitted.");
    } catch (error) {
      $("#applicationNotice").textContent = error.message;
      toast(error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Application";
    }
  });

  function updateSubmitState() {
    const f = $("#applicationForm").elements;
    const allFilled =
      f.name.value.trim() &&
      f.discord.value.trim() &&
      f.age.value.trim() &&
      f.factionCharacter.value &&
      f.bannedHistory.value.trim() &&
      f.roleplayPhilosophy.value.trim() &&
      f.characterDescription.value.trim();
    $("#applicationForm [type=submit]").disabled = !allFilled;
  }

  const appFormFields = ["name", "discord", "age", "factionCharacter", "roleplayPhilosophy", "characterDescription", "bannedHistory"];
  appFormFields.forEach((name) => {
    $("#applicationForm").elements[name].addEventListener("input", updateSubmitState);
    $("#applicationForm").elements[name].addEventListener("change", updateSubmitState);
  });
  updateSubmitState();

  // Start tracking tab-switches and elapsed time only once someone actually
  // starts the application, so browsing the rest of the site beforehand
  // doesn't count against them.
  $("#applicationForm").addEventListener("focusin", () => {
    awayTracking = true;
    if (!formStartedAt) formStartedAt = Date.now();
  }, { once: true });

  APPLICATION_ESSAY_FIELDS.forEach((name) => {
    const field = $("#applicationForm").elements[name];
    field?.addEventListener("paste", (e) => {
      recordPasteSample(name, e.clipboardData?.getData("text") || "");
    });
    field?.addEventListener("input", () => recordTypingSnapshot(name, field.value));
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) markAway(); else markBack();
  });
  window.addEventListener("blur", markAway);
  window.addEventListener("focus", markBack);

  ["searchInput", "activityFilter", "rankFilter"].forEach((id) => {
    $(`#${id}`).addEventListener("input", () => {
      activeCategoryFilter = "";
      $$(".category-card").forEach((card) => card.classList.remove("active"));
      renderRosterTable();
      renderEntryList();
    });
  });

  $("#hideVacantToggle").addEventListener("change", () => {
    activeCategoryFilter = "";
    $$(".category-card").forEach((card) => card.classList.remove("active"));
    renderRosterTable();
  });

  $("#categoryOverview").addEventListener("click", (event) => {
    const button = event.target.closest("[data-category-filter]");
    if (!button) return;
    // Click active card again → clear filter
    const isActive = button.classList.contains("active");
    activeCategoryFilter = isActive ? "" : button.dataset.categoryFilter;
    $$(".category-card").forEach((card) => card.classList.toggle("active", !isActive && card === button));
    $("#rankFilter").value = "";
    $("#activityFilter").value = "";
    $("#searchInput").value = "";
    renderRosterTable();
    renderEntryList();
  });

  // Sign-in modal open/close
  $("#previewRolePicker").addEventListener("change", (e) => activatePreview(e.target.value));
  $("#exitPreviewBtn").addEventListener("click", exitPreview);

  $("#signInBtn").addEventListener("click", () => {
    $("#signInPanel").classList.remove("hidden");
    $("#registerPanel").classList.add("hidden");
    $("#signInModal").classList.remove("hidden");
    $("#loginForm").querySelector("[name='email']").focus();
  });
  $("#signInModal").addEventListener("click", (e) => {
    if (e.target === $("#signInModal")) $("#signInModal").classList.add("hidden");
  });

  // Toggle between sign-in and register panels
  $("#showRegisterBtn").addEventListener("click", () => {
    $("#signInPanel").classList.add("hidden");
    $("#registerPanel").classList.remove("hidden");
    $("#registerForm").querySelector("[name='name']").focus();
  });
  $("#showSignInBtn").addEventListener("click", () => {
    $("#registerPanel").classList.add("hidden");
    $("#signInPanel").classList.remove("hidden");
    $("#loginForm").querySelector("[name='email']").focus();
  });

  async function handleAuthSuccess(user) {
    sessionUser = user;
    $("#signInModal").classList.add("hidden");
    $("#loginForm").reset();
    $("#registerForm").reset();
    setDashboardState();
    await loadPermittedData();
    showView("dashboard");
    toast(`Welcome, ${sessionUser.name}.`);
  }

  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = event.currentTarget.elements;
    const errEl = $("#loginError");
    errEl.classList.add("hidden");
    try {
      const data = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ email: fields.email.value, password: fields.password.value })
      });
      await handleAuthSuccess(data.user);
    } catch (error) {
      errEl.textContent = error.message;
      errEl.classList.remove("hidden");
    }
  });

  $("#registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = event.currentTarget.elements;
    const errEl = $("#registerError");
    errEl.classList.add("hidden");
    try {
      const data = await api("/api/register", {
        method: "POST",
        body: JSON.stringify({ name: fields.name.value, email: fields.email.value, password: fields.password.value })
      });
      await handleAuthSuccess(data.user);
    } catch (error) {
      errEl.textContent = error.message;
      errEl.classList.remove("hidden");
    }
  });

  $("#signOutBtn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    sessionUser = null;
    setDashboardState();
    toast("Signed out.");
  });

  $("#entryList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-entry-id]");
    if (!button) return;
    selectedEntryId = button.dataset.entryId;
    entryToForm(rosterData.roster.find((entry) => entry.id === selectedEntryId));
    renderEntryList();
  });

  $("#newEntryButton").addEventListener("click", () => {
    selectedEntryId = null;
    entryToForm(null);
    renderEntryList();
  });

  // When rank changes, clear the callsign and force the user to pick an
  // available slot for the new rank. The current slot stays in the list
  // (as "keep current slot") so changing rank in place is still possible.
  $("#rankPicker").addEventListener("change", (e) => {
    const originalEntry = rosterData.roster.find((entry) => entry.id === selectedEntryId);
    populateEntryCallsigns(e.target.value, originalEntry?.callsign || "", "");
  });

  $("#entryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!sessionUser?.canEditRoster) return toast("No edit permission.");
    const entry = formToEntry();
    try {
      const saved = entry.id
        ? await api(`/api/roster/${encodeURIComponent(entry.id)}`, { method: "PUT", body: JSON.stringify(entry) })
        : await api("/api/roster", { method: "POST", body: JSON.stringify(entry) });
      await loadRoster();
      selectedEntryId = saved.id;
      entryToForm(saved);
      toast("Roster entry saved.");
    } catch (error) {
      toast(error.message);
    }
  });

  $("#deleteEntryButton").addEventListener("click", async () => {
    if (!selectedEntryId || !sessionUser?.canEditRoster) return;
    await api(`/api/roster/${encodeURIComponent(selectedEntryId)}`, { method: "DELETE" });
    selectedEntryId = null;
    entryToForm(null);
    await loadRoster();
    toast("Roster entry deleted.");
  });

  $("#refreshApplicationsButton").addEventListener("click", () => loadApplications());
  $("#refreshBugReportsBtn").addEventListener("click", () => loadBugReports());

  // Bug report FAB + modal
  $("#bugReportBtn").addEventListener("click", () => {
    const form = $("#bugReportForm");
    form.reset();
    $("#bugReportNotice").classList.add("hidden");
    // Hide anon fields if signed in
    $("#bugAnonFields").classList.toggle("hidden", Boolean(sessionUser));
    $("#bugReportModal").classList.remove("hidden");
  });
  $("#bugReportCancelBtn").addEventListener("click", () => $("#bugReportModal").classList.add("hidden"));
  $("#bugReportModal").addEventListener("click", (e) => {
    if (e.target === $("#bugReportModal")) $("#bugReportModal").classList.add("hidden");
  });

  $("#bugReportForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fields = e.target.elements;
    const notice = $("#bugReportNotice");
    try {
      await api("/api/bugs", {
        method: "POST",
        body: JSON.stringify({
          description: fields.description.value,
          section: fields.section.value,
          name: fields.name?.value || "",
          email: fields.email?.value || "",
        })
      });
      $("#bugReportModal").classList.add("hidden");
      toast("Bug report submitted — thank you!");
      if (sessionUser?.canEditRoster || sessionUser?.canManageUsers) await loadBugReports();
    } catch (err) {
      notice.textContent = err.message;
      notice.classList.remove("hidden");
    }
  });

  // Bug report resolve/reopen
  $("#bugReportList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-bug-id]");
    if (!btn) return;
    const id = btn.dataset.bugId;
    const action = btn.dataset.action;
    try {
      await api(`/api/bugs/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ status: action === "close" ? "closed" : "open" })
      });
      await loadBugReports();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#entrySearch").addEventListener("input", (e) => {
    entryListQuery = e.target.value;
    renderEntryList();
  });

  $("#applicationList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-application-id]");
    if (!button) return;
    const application = applications.find((item) => item.id === button.dataset.applicationId);
    applicationToAcceptForm(application);
  });

  $("#acceptApplicationForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canReviewApplications()) return toast("No permission to review applications.");
    const id = event.currentTarget.elements.applicationId.value;
    if (!id) return toast("Select an application first.");
    try {
      // No callsign or rank here any more — accepting just moves them into the
      // pipeline. Rank and callsign are chosen together at Academy Passed.
      await api(`/api/applications/${encodeURIComponent(id)}/accept`, {
        method: "POST",
        body: JSON.stringify({})
      });
      await Promise.all([loadApplications(), loadOnboarding()]);
      toast("Accepted — moved to the recruit pipeline.");
    } catch (error) {
      toast(error.message);
    }
  });

  $("#rejectApplicationButton").addEventListener("click", () => {
    const id = $("#acceptApplicationForm").elements.applicationId.value;
    if (!id) return;
    const app = applications.find((a) => a.id === id);
    $("#rejectApplicantName").textContent = app?.name || "this applicant";
    $("#rejectForm").reset();
    $("#rejectModal").classList.remove("hidden");
  });

  $("#rejectCancelBtn").addEventListener("click", () => $("#rejectModal").classList.add("hidden"));
  $("#rejectModal").addEventListener("click", (e) => {
    if (e.target === $("#rejectModal")) $("#rejectModal").classList.add("hidden");
  });

  // Full application review modal
  $("#expandReviewBtn").addEventListener("click", openReviewModal);

  $("#reviewModalCloseBtn").addEventListener("click", closeReviewModal);
  $("#reviewModal").addEventListener("click", (e) => {
    if (e.target === $("#reviewModal")) closeReviewModal();
  });

  $("#reviewModalBody").addEventListener("click", async (e) => {
    const replayBtn = e.target.closest("[data-replay-field]");
    if (replayBtn) {
      const field = replayBtn.dataset.replayField;
      // Same button toggles: pause if this field is mid-replay, else play.
      if (replayControllers.has(field)) {
        finishReplay(field);
      } else {
        const scrub = document.querySelector(`[data-replay-scrub="${CSS.escape(field)}"]`);
        playTypingReplay(field, Number(scrub?.value || 0));
      }
      return;
    }

    const compareBtn = e.target.closest("[data-compare-id]");
    if (compareBtn) {
      stopAllReplays();
      const other = applications.find((a) => a.id === compareBtn.dataset.compareId);
      openCompareView(compareBtn.dataset.compareField, other);
      return;
    }

    if (e.target.id === "compareBackBtn") {
      renderReviewModal();
      return;
    }

    if (e.target.id === "addNoteBtn") {
      const input = $("#noteInput");
      const text = input.value.trim();
      if (!text) return;
      e.target.disabled = true;
      try {
        await api(`/api/applications/${encodeURIComponent(currentReviewApplication.id)}/notes`, {
          method: "POST",
          body: JSON.stringify({ text })
        });
        await loadApplications();
        currentReviewApplication = applications.find((a) => a.id === currentReviewApplication.id) || currentReviewApplication;
        renderReviewModal();
        toast("Note added.");
      } catch (err) {
        toast(err.message);
        e.target.disabled = false;
      }
    }
  });

  $("#reviewModalBody").addEventListener("input", (e) => {
    const scrub = e.target.closest("[data-replay-scrub]");
    if (!scrub) return;
    const field = scrub.dataset.replayScrub;
    finishReplay(field);
    renderReplayFrame(field, Number(scrub.value));
  });

  // Archive / unarchive / delete
  $("#archiveApplicationBtn").addEventListener("click", async () => {
    if (!currentReviewApplication) return;
    const archiving = !currentReviewApplication.archived;
    try {
      await api(`/api/applications/${encodeURIComponent(currentReviewApplication.id)}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived: archiving })
      });
      await loadApplications();
      closeReviewModal();
      toast(archiving ? "Application archived." : "Application restored.");
    } catch (err) {
      toast(err.message);
    }
  });

  $("#deleteApplicationBtn").addEventListener("click", () => {
    if (!currentReviewApplication) return;
    $("#deleteApplicationName").textContent = currentReviewApplication.name;
    $("#deleteApplicationModal").classList.remove("hidden");
  });

  $("#deleteApplicationCancelBtn").addEventListener("click", () => {
    $("#deleteApplicationModal").classList.add("hidden");
  });

  $("#deleteApplicationConfirmBtn").addEventListener("click", async () => {
    if (!currentReviewApplication) return;
    const id = currentReviewApplication.id;
    $("#deleteApplicationModal").classList.add("hidden");
    try {
      await api(`/api/applications/${encodeURIComponent(id)}`, { method: "DELETE" });
      selectedApplicationId = null;
      await loadApplications();
      closeReviewModal();
      toast("Application permanently deleted.");
    } catch (err) {
      toast(err.message);
    }
  });

  $("#showArchivedToggle").addEventListener("change", () => {
    showArchivedApplications = $("#showArchivedToggle").checked;
    renderApplications();
  });

  $("#rejectForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#acceptApplicationForm").elements.applicationId.value;
    const fields = e.target.elements;
    try {
      await api(`/api/applications/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: fields.reason.value, notes: fields.notes.value })
      });
      $("#rejectModal").classList.add("hidden");
      selectedApplicationId = null;
      await loadApplications();
      toast("Application rejected.");
    } catch (err) {
      toast(err.message);
    }
  });

  // ── Rank Manager ──
  $("#rankManagerList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-rank-index]");
    if (!row) return;
    const index = Number(row.dataset.rankIndex);
    const move = event.target.closest("[data-rank-move]")?.dataset.rankMove;
    if (move) {
      const target = move === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= rankDraft.length) return;
      [rankDraft[index], rankDraft[target]] = [rankDraft[target], rankDraft[index]];
      markRankDraftDirty(true);
      renderRankManager();
      return;
    }
    if (event.target.closest("[data-rank-remove]")) {
      rankDraft.splice(index, 1);
      markRankDraftDirty(true);
      renderRankManager();
    }
  });

  $("#rankManagerList").addEventListener("input", (event) => {
    const row = event.target.closest("[data-rank-index]");
    const field = event.target.dataset.rankField;
    if (!row || !field) return;
    rankDraft[Number(row.dataset.rankIndex)][field] = event.target.value;
    markRankDraftDirty(true);
  });

  $("#addRankForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = event.currentTarget.elements;
    const name = fields.name.value.trim();
    if (!name) return;
    if (rankDraft.some((rank) => rank.name.toLowerCase() === name.toLowerCase())) {
      return toast("That rank already exists.");
    }
    rankDraft.push({ name, category: fields.category.value.trim() || "Other", aliases: [] });
    markRankDraftDirty(true);
    event.currentTarget.reset();
    renderRankManager();
    toast("Added — drag it into place with ▲▼, then Save.");
  });

  $("#saveRanksBtn").addEventListener("click", saveRanks);

  $("#restoreRanksBtn").addEventListener("click", async () => {
    if (!confirm("Restore the default rank list? Any custom ranks you added will be removed.")) return;
    try {
      const data = await api("/api/ranks/restore", { method: "POST" });
      rankList = data.ranks;
      rankCategories = buildRankCategories();
      markRankDraftDirty(false);
      renderRankManager();
      renderAll();
      toast("Default ranks restored.");
    } catch (error) {
      toast(error.message);
    }
  });

  // ── Discord ──
  $("#refreshDiscordBtn").addEventListener("click", loadDiscordSettings);
  $("#saveDiscordBtn").addEventListener("click", saveDiscordSettings);

  $("#discordStatus").addEventListener("click", async (event) => {
    if (event.target.id === "discordLinkBtn" || event.target.id === "discordRefreshRolesBtn") {
      // Same OAuth round trip either way; refresh=1 just skips the consent
      // screen for someone who already authorised.
      const refresh = event.target.id === "discordRefreshRolesBtn";
      try {
        const { url } = await api(`/api/discord/link${refresh ? "?refresh=1" : ""}`);
        window.location.href = url;
      } catch (error) {
        toast(error.message);
      }
    }
    if (event.target.id === "discordResyncBtn") {
      if (!confirm("Re-apply the role mapping to every linked account?\n\nAnyone whose Discord roles are mapped gets those permissions — this overwrites permissions set by hand for those accounts. Admins are left alone.")) return;
      const button = event.target;
      button.disabled = true;
      try {
        const result = await api("/api/discord/resync", { method: "POST" });
        await Promise.all([loadUsers(), loadDiscordSettings()]);
        toast(result.updated
          ? `${result.updated} account${result.updated === 1 ? "" : "s"} updated.`
          : "Nothing changed — everyone already matches the mapping.");
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    }
    if (event.target.id === "discordUnlinkBtn") {
      try {
        await api("/api/discord/unlink", { method: "POST" });
        await loadDiscordSettings();
        toast("Discord unlinked.");
      } catch (error) {
        toast(error.message);
      }
    }
  });

  $("#discordRoleMap").addEventListener("change", (event) => {
    const row = event.target.closest("[data-role-index]");
    const perm = event.target.dataset.rolePerm;
    if (!row || !perm) return;
    const entry = discordState.settings.roleMap[Number(row.dataset.roleIndex)];
    entry.permissions = { ...entry.permissions, [perm]: event.target.checked };
  });

  $("#discordRoleMap").addEventListener("click", (event) => {
    const row = event.target.closest("[data-role-index]");
    if (!row || !event.target.closest("[data-role-remove]")) return;
    discordState.settings.roleMap.splice(Number(row.dataset.roleIndex), 1);
    renderDiscordPanel();
  });

  $("#addDiscordRoleForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = event.currentTarget.elements;
    const roleId = fields.roleId.value.trim();
    if (!/^\d{5,25}$/.test(roleId)) return toast("That doesn't look like a Discord role ID.");
    discordState.settings.roleMap.push({
      roleId,
      label: fields.label.value.trim(),
      rank: fields.rank.value.trim(),
      permissions: { canEditRoster: false, canManageUsers: false, canOnboard: false, canManageRanks: false }
    });
    event.currentTarget.reset();
    renderDiscordPanel();
  });

  $("#refreshAuditBtn").addEventListener("click", loadRosterAudit);

  $("#userList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-user-id]");
    if (!button) return;
    userToForm(users.find((user) => user.id === button.dataset.userId));
  });

  $("#newUserButton").addEventListener("click", () => userToForm());

  // Auto-fill permission checkboxes when role changes (uses module-level ROLE_PERMISSIONS)
  $("#rolePicker").addEventListener("change", (e) => {
    const perms = ROLE_PERMISSIONS[e.target.value];
    if (!perms) return;
    const fields = $("#userForm").elements;
    fields.canEditRoster.checked  = perms.canEditRoster;
    fields.canManageUsers.checked = perms.canManageUsers;
    fields.canOnboard.checked     = perms.canOnboard;
    fields.canManageRanks.checked = perms.canManageRanks;
  });

  $("#deleteUserButton").addEventListener("click", async () => {
    const fields = $("#userForm").elements;
    const id = fields.id.value;
    const target = users.find((user) => user.id === id);
    if (!target) return;
    if (!confirm(`Delete ${target.name} (${target.email})? They lose access immediately. This cannot be undone.`)) return;
    try {
      await api(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadUsers();
      userToForm();
      toast("User deleted.");
    } catch (error) {
      toast(error.message);
    }
  });

  $("#userForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = form.elements;
    const payload = {
      id: fields.id.value,
      name: fields.name.value,
      email: fields.email.value,
      password: fields.password.value,
      role: fields.role.value,
      canEditRoster: fields.canEditRoster.checked,
      canManageUsers: fields.canManageUsers.checked,
      canOnboard: fields.canOnboard.checked,
      canManageRanks: fields.canManageRanks.checked
    };
    try {
      if (payload.id) {
        await api(`/api/users/${encodeURIComponent(payload.id)}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await api("/api/users", { method: "POST", body: JSON.stringify(payload) });
      }
      await loadUsers();
      userToForm();
      toast("User permissions saved.");
    } catch (error) {
      toast(error.message);
    }
  });
}

wireEvents();
// Ranks first — the roster render groups entries by rank category.
await loadRanks();
await loadRoster();
entryToForm(null);
await loadSession();
// After session loads, restore the tab from the URL hash (permission-safe)
const hashView = location.hash.slice(1);
if (hashView === "apply") {
  showView("apply");
} else if (hashView === "dashboard" && sessionUser?.canEditRoster) {
  showView("dashboard");
} else if (hashView === "onboarding" && (canOnboard() || sessionUser?.canEditRoster)) {
  showView("onboarding");
}
await checkSavedApplicationStatus();

