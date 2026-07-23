# PD Roster

A police department roster management web app for a roleplay community (Los Santos PD). No npm dependencies — pure Node.js ESM, vanilla JS frontend, JSON file storage.

## Running

```bash
node server.js        # starts on http://localhost:3000
npm run dev           # same
```

Seed accounts (pre-loaded in `data/users.json`, passwords scrypt-hashed — rotate via the dashboard Users panel, not documented here):
- `admin@pd.local` — full permissions
- `editor@pd.local` — can edit roster
- `viewer@pd.local` — read-only dashboard

## Architecture

```
server.js           — single-file HTTP server, all API routes
public/
  index.html        — SPA shell with all three views
  app.js            — vanilla JS, handles routing and API calls
  styles.css        — all styles
data/
  roster.json       — roster entries (source of truth)
  users.json        — user accounts with hashed-less passwords
  applications.json — join applications
  source-roster.csv — original import source
scripts/
  import-roster.mjs — Google Sheets → roster.json importer
```

## Key facts

**Auth**: In-memory session Map (resets on server restart). Cookie `pd_session` (HttpOnly, 8h) — sessions are also expired server-side on access (`isSessionExpired`) and swept hourly, not just relying on the cookie's own expiry. Passwords are scrypt-hashed (`hashPassword`/`verifyPassword` in server.js); a boot-time migration (`migratePlaintextPasswords`) upgrades any account still storing a plaintext password (e.g. a data volume seeded before hashing shipped). Two permission flags: `canEditRoster`, `canManageUsers`, plus `canOnboard`.

**Write serialization**: every POST/PUT/DELETE under `/api/` runs through a single in-process write queue (`withWriteLock` in server.js) so concurrent requests can't race past a read-check-write uniqueness check (callsign conflicts, duplicate emails, etc). GET requests aren't queued.

**Roster entry fields**: `id`, `callsign`, `name`, `activity`, `rank`, `divisions` (object of booleans), `strikes` (object of booleans), `notes`, `employeeNotes`, `promotionDate`, `tig`, `vacant`, `clearedForPatrol`. `vacant` is always derived server-side from `activity`/`name` in `sanitizeRosterEntry` (`activity === "Vacant" || !name`) — never trust it directly from client input, that was a real bug (a filled-in entry could save with a stale `vacant: true` and become invisible everywhere vacant slots are filtered out).

**Callsign uniqueness** is enforced server-side (`occupiedCallsignConflict` in server.js) on every path that assigns a callsign to a roster entry — new entry creation, the Promote/Reassign swap, application acceptance, and the onboarding Academy-Passed flow. The frontend also restricts callsign pickers to vacant slots, but that's a UX convenience only; the server is the actual guard.

**Rank categories** (defined in `app.js`): High Command → Command → Supervisor → Supervisor In Training → Patrol Officer → Probationary Officer → Officer In Training. These drive the category overview cards on the public roster.

**Divisions/strikes**: single source of truth is `roster.json` (`divisions`/`strikes` arrays), read via the API in `loadRoster()`. Don't hardcode a duplicate list in `app.js`.

**Application review signals** (for staff, not applicants — see `sanitizeApplication`, `findSimilarApplications` in server.js): `pastedFields` and `awayCount`/`awayTotalMs` are client-reported (best-effort, informational only, sanitized on the way in); `similarityFlags` is computed server-side at submission time via Jaccard similarity over word-shingles against every prior application's essay fields, and is never trusted from client input. None of this blocks submission or proves anything — it's just context surfaced in the dashboard's application detail panel.

**API routes**:
- `GET /api/roster` — public, no auth
- `GET /api/session` — returns current user
- `POST /api/login` / `POST /api/logout` / `POST /api/register`
- `POST /api/applications` — public, submit application
- `GET /api/applications` — requireEdit or canOnboard
- `POST /api/applications/:id/accept` — creates/fills a roster entry
- `POST /api/applications/:id/reject`
- `GET/POST /api/roster` — GET public, POST requireEdit
- `PUT/DELETE /api/roster/:id` — requireEdit
- `GET/POST /api/users`, `PUT /api/users/:id` — requireManageUsers
- `GET/PUT/DELETE /api/onboarding[/:id]` — requireOnboard
- `POST/GET/PUT /api/bugs[/:id]` — submit public, view/manage requires edit or manage-users perms

## Frontend asset caching — important

`public/index.html` is served `no-cache, must-revalidate` (always fresh), but `app.js`/`styles.css` are served with a **1-year cache** (see `cacheControlFor` in server.js). The only way a browser picks up changes to those files is the `?v=N` query param on their `<script>`/`<link>` tags in `index.html`. **Every time you edit `public/app.js` or `public/styles.css`, bump its `?v=` number in `index.html` — otherwise returning visitors keep serving a stale cached copy for up to a year, silently.** This already caused a real bug once (a whole session's worth of frontend changes went live server-side but never reached an already-visited browser because the version number wasn't bumped).

## Data files

`data/roster.json` also stores `department`, `divisions` (array), `strikes` (array), `importedAt`, `source`, `updatedAt`, `updatedBy`.

## Re-importing the roster from Google Sheets

`npm run import:roster` fetches the live roster sheet (CSV export, no API key needed — the sheet must stay shared as "Anyone with the link can view") and overwrites `data/roster.json` and `data/source-roster.csv`. Uses Node's built-in `fetch`, no new dependency. Duplicate callsigns in the sheet are automatically collapsed (prefers the active/named row over vacant duplicates). Falls back to the local `data/source-roster.csv` snapshot if the fetch fails (offline, sheet made private, etc).

To import from a different sheet, pass its URL or ID as an argument: `node scripts/import-roster.mjs "https://docs.google.com/spreadsheets/d/.../edit#gid=..."`.

Re-importing only updates the seed file — on Railway, `syncSeedImport()` in `server.js` compares `importedAt` and replaces the live volume's roster automatically on next deploy if the seed is newer.

Do not add a build step, bundler, or npm packages without discussing first — the zero-dependency constraint is intentional.
