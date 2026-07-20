// Populated from the API in loadRoster() — roster.json is the single source
// of truth for divisions/strikes, don't hardcode a duplicate list here.
let divisions = [];
let strikes = [];

let rosterData = { roster: [] };
let sessionUser = null;
let realSessionUser = null; // set when admin is previewing another role
let selectedEntryId = null;
let selectedApplicationId = null;
let users = [];
let applications = [];
let onboardingCards = [];
let pendingTerminationId = null;
let pendingAcademyCardId = null;
let pendingClearForPatrolId = null;
let promoteEntryId = null;
let activeCategoryFilter = "";
let entryListQuery = "";

const onboardingStages = [
  "Application Pending",
  "Application Accepted",
  "Academy Scheduled",
  "Academy Passed",
  "Ride Alongs Completed",
  "Cleared For Patrol"
];

// How long a card can sit in each stage before it decays (ms). null = no decay.
const STAGE_DECAY_MS = {
  "Application Pending":   48 * 3600 * 1000,
  "Application Accepted":  24 * 3600 * 1000,
  "Academy Scheduled":     72 * 3600 * 1000,
  "Academy Passed":        72 * 3600 * 1000,
  "Ride Alongs Completed": 72 * 3600 * 1000,
  "Cleared For Patrol":    null,
};

let decayTimerInterval = null;

const rankCategories = [
  {
    name: "High Command",
    ranks: ["Commissioner", "Commisioner", "Chief", "Chief Of Police", "Assistant Chief", "Deputy Chief", "Commander"]
  },
  {
    name: "Command",
    ranks: ["Captain", "Lieutenant"]
  },
  {
    name: "Supervisor",
    ranks: ["Master Sergeant", "Staff Sergeant", "DCI Staff Sergeant", "Staff Sergeant DCI", "Sergeant"]
  },
  {
    name: "Supervisor In Training",
    ranks: ["Corporal"]
  },
  {
    name: "Patrol Officer",
    ranks: ["Sr. Officer", "Officer II", "Officer I"]
  },
  {
    name: "Probationary Officer",
    ranks: ["Probationary Officer"]
  },
  {
    name: "Officer In Training",
    ranks: ["Recruit"]
  }
];

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

function categoryForRank(rank) {
  const cleaned = cleanRank(rank);
  return rankCategories.find((category) => category.ranks.some((item) => cleanRank(item) === cleaned))?.name || "Other";
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
  const sorted = [...applications].sort((a, b) => {
    const order = { pending: 0, accepted: 1, rejected: 2 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(b.submittedAt).localeCompare(String(a.submittedAt));
  });
  $("#applicationList").innerHTML = sorted.length
    ? sorted
        .map(
          (application) => `<button class="mini-item application-item ${application.id === selectedApplicationId ? "active" : ""}" data-application-id="${application.id}">
            <span><strong>${escapeHtml(application.name)}</strong><br><small>${escapeHtml(application.discord)}</small></span>
            <small>${escapeHtml(formatDate(application.submittedAt))}</small>
            <small class="${statusClass(application.status)}">${escapeHtml(application.status)}</small>
          </button>`
        )
        .join("")
    : `<div class="empty-state">No applications yet.</div>`;
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

function populateAcceptRankDropdown() {
  $("#acceptRankPicker").innerHTML = `<option value="Recruit">Recruit</option>`;
}

function populateAcceptCallsigns(rank) {
  const picker = $("#acceptCallsignPicker");
  if (!rank) {
    picker.innerHTML = `<option value="">— Select rank first —</option>`;
    picker.disabled = true;
    return;
  }
  const vacant = rosterData.roster.filter(
    (e) => (e.vacant || e.activity === "Vacant") && cleanRank(e.rank) === cleanRank(rank)
  );
  if (vacant.length) {
    picker.innerHTML = [
      `<option value="">— Select callsign —</option>`,
      ...vacant.map(
        (e) => `<option value="${escapeHtml(e.callsign)}" data-entry-id="${escapeHtml(e.id)}">${escapeHtml(e.callsign)}</option>`
      )
    ].join("");
  } else {
    picker.innerHTML = `<option value="">No vacant slots for this rank</option>`;
  }
  picker.disabled = false;
}

function applicationToAcceptForm(application) {
  const form = $("#acceptApplicationForm");
  const fields = form.elements;
  selectedApplicationId = application?.id || null;
  fields.applicationId.value = application?.id || "";
  fields.vacantEntryId.value = "";
  fields.name.value = application?.name || "";
  fields.promotionDate.value = new Date().toISOString().split("T")[0];
  populateAcceptRankDropdown();
  $("#acceptRankPicker").value = "";
  populateAcceptCallsigns("");
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
    ? appFields.map((f) =>
        `<div class="app-detail-field">
          <span class="app-detail-label">${escapeHtml(f.label)}</span>
          <p class="app-detail-value">${escapeHtml(String(f.value))}</p>
        </div>`
      ).join("")
    : `<p class="app-detail-empty">Select a pending application to review it.</p>`;
  $$("#acceptApplicationForm input, #acceptApplicationForm select, #acceptApplicationForm button").forEach((control) => {
    if (control.name === "name") return;
    if (control.id === "acceptCallsignPicker") return; // managed by rank selection
    control.disabled = !application || application.status !== "pending" || !sessionUser?.canEditRoster;
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
  viewer:     { canEditRoster: false, canManageUsers: false, canOnboard: false },
  onboarding: { canEditRoster: false, canManageUsers: false, canOnboard: true  },
  supervisor: { canEditRoster: true,  canManageUsers: false, canOnboard: false },
  command:    { canEditRoster: true,  canManageUsers: true,  canOnboard: true  },
  admin:      { canEditRoster: true,  canManageUsers: true,  canOnboard: true  },
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
  const canSeeOnboarding = sessionUser?.canOnboard || sessionUser?.role === "admin";
  const canSeeApplications = sessionUser?.canEditRoster || sessionUser?.canOnboard || sessionUser?.role === "admin";
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
  if (sessionUser?.canEditRoster || sessionUser?.canOnboard) await loadApplications();
  if (sessionUser?.canManageUsers) await loadUsers();
  if (sessionUser?.canOnboard || sessionUser?.role === "admin") await loadOnboarding();
  if (sessionUser?.canEditRoster || sessionUser?.canManageUsers) await loadBugReports();
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

async function loadOnboarding() {
  const data = await api("/api/onboarding");
  onboardingCards = data.cards;
  renderKanban();
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
              <strong>${escapeHtml(card.name)}</strong>
              <small class="card-discord">${escapeHtml(card.discord)}</small>
              ${card.callsign || card.rank ? `<div class="card-meta">
                ${card.callsign ? `<span class="pill">${escapeHtml(card.callsign)}</span>` : ""}
                ${card.rank ? `<span class="pill">${escapeHtml(card.rank)}</span>` : ""}
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
      const cardId = e.dataTransfer.getData("text/plain");
      const targetStage = zone.dataset.stage;
      const card = onboardingCards.find((c) => c.id === cardId);
      if (!card || card.stage === targetStage) return;

      if (targetStage === "Academy Passed") {
        pendingAcademyCardId = cardId;
        populateAcademyRankDropdown();
        $("#academyPassedModal").classList.remove("hidden");
        return;
      }

      if (targetStage === "Cleared For Patrol") {
        pendingClearForPatrolId = cardId;
        $("#clearForPatrolName").textContent = card.name || "this recruit";
        $("#clearForPatrolModal").classList.remove("hidden");
        return;
      }

      await moveOnboardingCard(cardId, targetStage);
    });
  });
}

async function moveOnboardingCard(cardId, stage, extra = {}) {
  try {
    await api(`/api/onboarding/${encodeURIComponent(cardId)}`, {
      method: "PUT",
      body: JSON.stringify({ stage, ...extra })
    });
    // Always reload both so roster badges (clearedForPatrol, rank, etc.) stay in sync
    await Promise.all([loadOnboarding(), loadRoster()]);
    toast(`Moved to "${stage}"`);
  } catch (err) {
    toast(err.message);
  }
}

function populateAcademyRankDropdown() {
  $("#academyRankPicker").innerHTML = rankCategories
    .map(
      (cat) => `<optgroup label="${escapeHtml(cat.name)}">${cat.ranks
        .map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`)
        .join("")}</optgroup>`
    )
    .join("");
  $("#academyRankPicker").value = "Probationary Officer";
  populateAcademyCallsigns("Probationary Officer");
}

function populateAcademyCallsigns(rank) {
  const picker = $("#academyCallsignPicker");
  const vacant = rosterData.roster.filter(
    (e) => (e.vacant || e.activity === "Vacant") && cleanRank(e.rank) === cleanRank(rank)
  );
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
  if (view === "onboarding" && (sessionUser?.canOnboard || sessionUser?.role === "admin")) {
    loadOnboarding();
    if (sessionUser?.canEditRoster || sessionUser?.canOnboard) loadApplications();
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

  $("#academyRankPicker").addEventListener("change", () => {
    populateAcademyCallsigns($("#academyRankPicker").value);
  });

  $("#academyConfirmBtn").addEventListener("click", async () => {
    if (!pendingAcademyCardId) return;
    const callsign = $("#academyCallsignPicker").value;
    if (!callsign) { toast("Please select a callsign."); return; }
    const rank = $("#academyRankPicker").value;
    const id = pendingAcademyCardId;
    pendingAcademyCardId = null;
    $("#academyPassedModal").classList.add("hidden");
    await moveOnboardingCard(id, "Academy Passed", { callsign, rank });
  });

  $("#academyCancelBtn").addEventListener("click", () => {
    pendingAcademyCardId = null;
    $("#academyPassedModal").classList.add("hidden");
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

  $("#academyPassedModal").addEventListener("click", (e) => {
    if (e.target === $("#academyPassedModal")) {
      pendingAcademyCardId = null;
      $("#academyPassedModal").classList.add("hidden");
    }
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
      if (sessionUser?.canEditRoster || sessionUser?.canOnboard) await loadApplications();
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
          clips: fields.clips.value
        })
      });
      localStorage.setItem("pd_application_id", next.application.id);
      form.reset();
      updateSubmitState();
      showApplicationStatus(next.application);
      if (sessionUser?.canEditRoster || sessionUser?.canOnboard) await loadApplications();
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
    if (sessionUser.canEditRoster || sessionUser.canOnboard) await loadApplications();
    if (sessionUser.canManageUsers) await loadUsers();
    if (sessionUser.canOnboard || sessionUser.role === "admin") await loadOnboarding();
    if (sessionUser.canEditRoster || sessionUser.canManageUsers) await loadBugReports();
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

  $("#acceptRankPicker").addEventListener("change", () => {
    const rank = $("#acceptRankPicker").value;
    populateAcceptCallsigns(rank);
    $("#acceptApplicationForm").elements.vacantEntryId.value = "";
  });

  $("#acceptCallsignPicker").addEventListener("change", () => {
    const select = $("#acceptCallsignPicker");
    const selectedOption = select.options[select.selectedIndex];
    const entryId = selectedOption?.dataset.entryId || "";
    $("#acceptApplicationForm").elements.vacantEntryId.value = entryId;
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
    if (!sessionUser?.canEditRoster) return toast("No edit permission.");
    const form = event.currentTarget;
    const fields = form.elements;
    const id = fields.applicationId.value;
    if (!id) return toast("Select an application first.");
    try {
      const callsignSelect = $("#acceptCallsignPicker");
      const callsign = callsignSelect.value;
      const result = await api(`/api/applications/${encodeURIComponent(id)}/accept`, {
        method: "POST",
        body: JSON.stringify({
          callsign,
          rank: fields.rank.value || "Cadet",
          promotionDate: fields.promotionDate.value,
          vacantEntryId: fields.vacantEntryId.value
        })
      });
      selectedEntryId = result.rosterEntry.id;
      await loadRoster();
      await loadApplications();
      entryToForm(result.rosterEntry);
      toast("Application accepted and cadet added.");
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
      canOnboard: fields.canOnboard.checked
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
await loadRoster();
entryToForm(null);
await loadSession();
// After session loads, restore the tab from the URL hash (permission-safe)
const hashView = location.hash.slice(1);
if (hashView === "apply") {
  showView("apply");
} else if (hashView === "dashboard" && sessionUser?.canEditRoster) {
  showView("dashboard");
} else if (hashView === "onboarding" && (sessionUser?.canOnboard || sessionUser?.role === "admin")) {
  showView("onboarding");
}
await checkSavedApplicationStatus();

