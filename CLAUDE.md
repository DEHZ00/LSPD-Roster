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
  ranks.json        — rank ladder + categories (Rank Manager edits this)
  discord.json      — Discord role → permission mapping (config only, no secrets)
  source-roster.csv — original import source
scripts/
  import-roster.mjs — Google Sheets → roster.json importer
discord.js          — Discord integration, dormant unless env vars are set
docs/
  discord.md        — Discord setup, security model, kill switches
```

## Key facts

**Auth**: In-memory session Map (resets on server restart). Cookie `pd_session` (HttpOnly, 8h) — sessions are also expired server-side on access (`isSessionExpired`) and swept hourly, not just relying on the cookie's own expiry. Passwords are scrypt-hashed (`hashPassword`/`verifyPassword` in server.js); a boot-time migration (`migratePlaintextPasswords`) upgrades any account still storing a plaintext password (e.g. a data volume seeded before hashing shipped). Permission flags: `canEditRoster`, `canManageUsers`, `canOnboard`, `canManageRanks`. Admins hold all four regardless of what's stored — applied by `effectivePermissions()`, which every `require*` guard and `publicUser()` goes through. Don't read a raw flag off a user record; that split (display used the admin override, the guards didn't) meant an admin with unchecked boxes saw full controls and got 403s.

**Write serialization**: every POST/PUT/DELETE under `/api/` runs through a single in-process write queue (`withWriteLock` in server.js) so concurrent requests can't race past a read-check-write uniqueness check (callsign conflicts, duplicate emails, etc). GET requests aren't queued.

**Roster entry fields**: `id`, `callsign`, `name`, `activity`, `rank`, `divisions` (object of booleans), `strikes` (object of booleans), `notes`, `employeeNotes`, `promotionDate`, `tig`, `vacant`, `clearedForPatrol`. `vacant` is always derived server-side from `activity`/`name` in `sanitizeRosterEntry` (`activity === "Vacant" || !name`) — never trust it directly from client input, that was a real bug (a filled-in entry could save with a stale `vacant: true` and become invisible everywhere vacant slots are filtered out).

**Callsign uniqueness** is enforced server-side (`occupiedCallsignConflict` in server.js) on every path that assigns a callsign to a roster entry — new entry creation, the Promote/Reassign swap, application acceptance, and the onboarding Academy-Passed flow. The frontend also restricts callsign pickers to vacant slots, but that's a UX convenience only; the server is the actual guard.

**Ranks**: single source of truth is `data/ranks.json`, served by `GET /api/ranks` and edited through the dashboard's Rank Manager (`canManageRanks`). It's a **flat array, ordered highest to lowest** — that order *is* the promotion ladder. Each entry has a `category` (the heading it appears under on the public roster) and `aliases` (old spellings already in roster.json, e.g. `Commisioner`, `DCI Staff Sergeant` — matched by `categoryForRank`, never offered in a picker). A category's ranks don't have to be adjacent: Lead Detective sits between Sergeant and Corporal in the ladder while sharing the Detective Bureau card with the ranks below Corporal.

Ranks live in their own file **on purpose**. `syncSeedImport()` replaces the entire live `roster.json` with the sheet-derived seed whenever a newer import ships, so ranks stored there would be silently wiped by the next `npm run import:roster` + deploy. Nothing in the import path touches `ranks.json`. `POST /api/ranks/restore` re-seeds from the repo copy; a rank still assigned to a roster entry can't be deleted (409).

**User authority ladder** (`ROLE_AUTHORITY` / `authorityOf` / `targetOutOfReach` in server.js): admin 3 › command 2 › supervisor & onboarding 1 › viewer 0. A manage-users account may only delete or change permissions on an account **strictly below its own level**, may not edit its own role or flags, and may not create or promote anyone to its own level. The last account holding `canManageUsers` can't be deleted. Enforced on POST, PUT and DELETE — the dashboard mirrors it for UX only. Before this, any `canManageUsers` account could PUT itself to admin.

**Roster audit log**: `recordRosterAudit`/`rosterDiff` append to `auditLog` inside `roster.json` (capped at 500, newest first) on every roster write — including Discord-driven ones, recorded as `system:discord`. It rides the same write lock as the change itself so the two can never disagree. **`GET /api/roster` is public and strips `auditLog`**; staff read it via `GET /api/roster/audit` (requireEdit). Don't send the raw roster file to an unauthenticated caller.

**Divisions/strikes**: single source of truth is `roster.json` (`divisions`/`strikes` arrays), read via the API in `loadRoster()`. Don't hardcode a duplicate list in `app.js`.

**Application review signals** (for staff, not applicants — see `sanitizeApplication`, `findSimilarApplications` in server.js): `pastedFields` and `awayCount`/`awayTotalMs` are client-reported (best-effort, informational only, sanitized on the way in); `similarityFlags` is computed server-side at submission time via Jaccard similarity over word-shingles against every prior application's essay fields, and is never trusted from client input. None of this blocks submission or proves anything — it's just context surfaced in the dashboard's application detail panel.

**API routes**:
- `GET /api/roster` — public, no auth
- `GET /api/session` — returns current user
- `POST /api/login` / `POST /api/logout` / `POST /api/register`
- `POST /api/applications` — public, submit application
- `GET /api/applications` — requireEdit or canOnboard
- `POST /api/applications/:id/accept` — marks accepted and advances the pipeline card; **writes nothing to the roster**
- `POST /api/applications/:id/reject`
- `GET/POST /api/roster` — GET public (audit log stripped), POST requireEdit
- `GET /api/roster/audit` — requireEdit
- `PUT/DELETE /api/roster/:id` — requireEdit
- `GET/POST /api/users`, `PUT/DELETE /api/users/:id` — requireManageUsers + authority ladder
- `GET /api/ranks` — public; `PUT /api/ranks`, `POST /api/ranks/restore` — requireManageRanks
- `GET /api/onboarding` — canOnboard or canEditRoster; `PUT/DELETE /api/onboarding/:id` — requireOnboard
- `POST/DELETE /api/onboarding/:id/callsign` — requireEdit (approve / decline a queued callsign)
- `GET /api/discord/config`, `GET /api/discord/link`, `GET /api/discord/callback`, `POST /api/discord/unlink` — signed in
- `GET/PUT /api/discord/settings` — requireManageUsers (role mapping only, never credentials)
- `POST/GET/PUT /api/bugs[/:id]` — submit public, view/manage requires edit or manage-users perms

## Onboarding: where a callsign gets assigned

Accepting an application does **not** touch the roster and does **not** assign a
callsign — it only flips the application to `accepted` and moves the pipeline
card to "Application Accepted". A callsign is a roster slot, so assigning one at
acceptance made accepting a roster write, which is what blocked onboarding-only
staff from accepting anyone at all.

Pipeline stages live in `ONBOARDING_STAGES` (server.js), are served with the
board by `GET /api/onboarding`, and are validated on every move — the frontend
list is only a first-paint fallback. Two of them assign a callsign, listed in
`CALLSIGN_STAGES` with the rank each implies:

| Stage | Rank |
|---|---|
| Interview Accepted | Recruit |
| Academy Passed | Probationary Officer |

**The callsign approval queue.** Writing a callsign needs `canEditRoster`, but
moving a card is onboarding work. So a move into a callsign stage by someone
without roster edit permission moves the card and leaves
`card.pendingCallsign = { stage, rank, requestedBy, requestedByEmail, requestedAt }`
instead of failing. A roster editor then picks the actual callsign via
`POST /api/onboarding/:id/callsign` (or clears it with `DELETE`). A roster
editor moving the card gets the picker immediately and skips the queue.
Moving a card *off* a callsign stage clears any request still queued against it.

All of it goes through one helper, `assignCallsignToCard` — fill a vacant slot,
move an existing entry, or create one, with a single `occupiedCallsignConflict`
check up front and nothing written when it returns an error. Don't reimplement
roster assignment anywhere else; the three-way branching is why this was
previously able to drop a recruit silently.

`GET /api/onboarding` is readable by `canOnboard` **or** `canEditRoster`, since
approving queued requests is the roster editor's job.

## Discord

`discord.js` is complete and **dormant**. No socket opens and no request leaves
the server unless the matching env vars are set. Every credential is read from
`process.env` and nowhere else — no route accepts, returns, or logs a token, no
file under `data/` stores one, and no dashboard field can change one, so a
compromised admin account can't switch it on. `data/discord.json` holds role→
permission mapping only. Discord roles can grant permission flags but never
`role: "admin"`. See `docs/discord.md` for setup and the per-feature kill
switches.

## Frontend asset caching — important

`public/index.html` is served `no-cache, must-revalidate` (always fresh), but `app.js`/`styles.css` are served with a **1-year cache** (see `cacheControlFor` in server.js). The only way a browser picks up changes to those files is the `?v=N` query param on their `<script>`/`<link>` tags in `index.html`. **Every time you edit `public/app.js` or `public/styles.css`, bump its `?v=` number in `index.html` — otherwise returning visitors keep serving a stale cached copy for up to a year, silently.** This already caused a real bug once (a whole session's worth of frontend changes went live server-side but never reached an already-visited browser because the version number wasn't bumped).

## Data files

`data/roster.json` also stores `department`, `divisions` (array), `strikes` (array), `importedAt`, `source`, `updatedAt`, `updatedBy`.

## Re-importing the roster from Google Sheets

`npm run import:roster` fetches the live roster sheet (CSV export, no API key needed — the sheet must stay shared as "Anyone with the link can view") and overwrites `data/roster.json` and `data/source-roster.csv`. Uses Node's built-in `fetch`, no new dependency. Duplicate callsigns in the sheet are automatically collapsed (prefers the active/named row over vacant duplicates). Falls back to the local `data/source-roster.csv` snapshot if the fetch fails (offline, sheet made private, etc).

To import from a different sheet, pass its URL or ID as an argument: `node scripts/import-roster.mjs "https://docs.google.com/spreadsheets/d/.../edit#gid=..."`.

Re-importing only updates the seed file — on Railway, `syncSeedImport()` in `server.js` compares `importedAt` and replaces the live volume's roster automatically on next deploy if the seed is newer.

Do not add a build step, bundler, or npm packages without discussing first — the zero-dependency constraint is intentional.
