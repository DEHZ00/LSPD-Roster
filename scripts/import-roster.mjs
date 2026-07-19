import fs from "node:fs/promises";
import path from "node:path";

const sourcePath = path.resolve("data/source-roster.csv");
const outputPath = path.resolve("data/roster.json");

// Same sheet the original CSV export came from — pass a different sheet URL
// or ID as the first CLI arg to import from somewhere else.
const DEFAULT_SHEET_ID = "1g5PBLmzfN8e0MIrcvCE4dswRjdX43onfju5OsX72u5U";
const DEFAULT_SHEET_GID = "1481132815";

function parseSheetArg(arg) {
  if (!arg) return { id: DEFAULT_SHEET_ID, gid: DEFAULT_SHEET_GID };
  const idMatch = arg.match(/\/d\/([a-zA-Z0-9-_]+)/);
  const gidMatch = arg.match(/[?&#]gid=(\d+)/);
  return {
    id: idMatch ? idMatch[1] : arg,
    gid: gidMatch ? gidMatch[1] : DEFAULT_SHEET_GID
  };
}

async function fetchSheetCsv(sheetArg) {
  const { id, gid } = parseSheetArg(sheetArg);
  const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Sheet fetch failed (${response.status}). Is it shared as "Anyone with the link can view"?`);
  }
  const csv = await response.text();
  // Google returns a 200 HTML sign-in page instead of CSV for private sheets.
  if (/^\s*<!DOCTYPE html/i.test(csv)) {
    throw new Error("Sheet did not return CSV (likely private). Share it as \"Anyone with the link can view\".");
  }
  return csv;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }

  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCallsign(value) {
  const cleaned = cleanText(value).replace(/[^\d]/g, "");
  return cleaned;
}

function bool(value) {
  return cleanText(value).toUpperCase() === "TRUE";
}

function normalizeTig(value) {
  const cleaned = cleanText(value);
  return cleaned && cleaned !== "#VALUE!" ? cleaned : "";
}

function normalizeDate(value) {
  const cleaned = cleanText(value);
  if (!cleaned || /^0+\/0+\/0+$/.test(cleaned)) return "";
  return cleaned;
}

function findHeaderIndex(cells, label) {
  return cells.findIndex((cell) => cleanText(cell).toUpperCase() === label);
}

function findHeaderIncludes(cells, label) {
  return cells.findIndex((cell) => cleanText(cell).toUpperCase().includes(label));
}

function hasRosterShape(cells, columns) {
  return Boolean(
    cleanCallsign(cells[columns.callsign]) ||
      cleanText(cells[columns.name]) ||
      cleanText(cells[columns.activity]) ||
      cleanText(cells[columns.rank])
  );
}

const sheetArg = process.argv[2];
let csv;
try {
  csv = await fetchSheetCsv(sheetArg);
  await fs.writeFile(sourcePath, csv);
  console.log("Fetched latest roster from Google Sheets.");
} catch (error) {
  console.warn(`Could not fetch sheet (${error.message}). Falling back to ${sourcePath}.`);
  csv = await fs.readFile(sourcePath, "utf8");
}
const rows = parseCsv(csv);
const headerIndex = rows.findIndex((cells) => cells.some((cell) => cleanText(cell).toUpperCase() === "CALLSIGN"));

if (headerIndex === -1) {
  throw new Error("Could not find CALLSIGN header row in source CSV.");
}

const header = rows[headerIndex];
const subheader = rows[headerIndex + 2] || [];
const columns = {
  callsign: findHeaderIndex(header, "CALLSIGN"),
  name: findHeaderIndex(header, "NAME"),
  activity: findHeaderIndex(header, "ACTIVITY"),
  rank: findHeaderIndex(header, "RANK"),
  divisions: findHeaderIndex(header, "DIVISIONS"),
  strikes: findHeaderIndex(header, "STRIKES"),
  notes: findHeaderIndex(header, "NOTES"),
  date: findHeaderIncludes(header, "DATE") >= 0 ? findHeaderIncludes(header, "DATE") : findHeaderIncludes(header, "PROMOTION"),
  tig: findHeaderIndex(header, "TIG")
};

const requiredColumns = ["callsign", "name", "activity", "rank", "divisions", "strikes", "notes", "date", "tig"];
for (const column of requiredColumns) {
  if (columns[column] < 0) throw new Error(`Could not find ${column} column in source CSV.`);
}

function namedColumnMap(start, end) {
  const result = [];
  for (let index = start; index < end; index += 1) {
    const label = cleanText(subheader[index]);
    if (label) result.push({ label, index });
  }
  return result;
}

const divisionColumns = namedColumnMap(columns.divisions, columns.strikes);
const strikeColumns = namedColumnMap(columns.strikes, columns.notes);

const roster = rows
  .slice(headerIndex + 3)
  .filter((cells) => hasRosterShape(cells, columns))
  .map((cells, index) => {
    const callsign = cleanCallsign(cells[columns.callsign]);
    const activity = cleanText(cells[columns.activity]);
    const rank = cleanText(cells[columns.rank]);
    const name = cleanText(cells[columns.name]);
    const vacant = activity === "Vacant" || (!name && activity === "Vacant");

    return {
      id: `${callsign || "slot"}-${index + 1}`,
      callsign,
      name,
      activity,
      rank,
      divisions: Object.fromEntries(divisionColumns.map(({ label, index: columnIndex }) => [label, bool(cells[columnIndex])])),
      strikes: Object.fromEntries(strikeColumns.map(({ label, index: columnIndex }) => [label, bool(cells[columnIndex])])),
      notes: cleanText(cells[columns.notes]),
      promotionDate: normalizeDate(cells[columns.date]),
      tig: normalizeTig(cells[columns.tig]),
      vacant
    };
  })
  .filter((entry) => entry.callsign || entry.name || entry.activity || entry.rank);

// The sheet itself carries duplicate callsigns (leftover vacant rows
// alongside the filled one) — collapse each callsign to a single entry,
// preferring the active/named row over vacant duplicates.
function dedupeByCallsign(entries) {
  const seen = new Map();
  for (const entry of entries) {
    if (!entry.callsign) { seen.set(entry.id, entry); continue; }
    const existing = seen.get(entry.callsign);
    if (!existing) { seen.set(entry.callsign, entry); continue; }
    const existingVacant = existing.vacant || existing.activity === "Vacant" || !existing.name;
    const thisVacant = entry.vacant || entry.activity === "Vacant" || !entry.name;
    if (existingVacant && !thisVacant) seen.set(entry.callsign, entry);
  }
  return [...seen.values()];
}

const dedupedRoster = dedupeByCallsign(roster);
if (dedupedRoster.length < roster.length) {
  console.log(`Collapsed ${roster.length - dedupedRoster.length} duplicate-callsign row(s) from the sheet.`);
}

const payload = {
  department: cleanText(rows[1]?.find((cell) => cleanText(cell)) || "Police Department"),
  importedAt: new Date().toISOString(),
  source: `https://docs.google.com/spreadsheets/d/${parseSheetArg(sheetArg).id}/edit`,
  divisions: divisionColumns.map(({ label }) => label),
  strikes: strikeColumns.map(({ label }) => label),
  roster: dedupedRoster
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Imported ${roster.length} roster entries to ${outputPath}`);
