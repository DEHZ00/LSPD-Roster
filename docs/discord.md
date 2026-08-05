# Discord integration

The integration is fully written and **switched off**. Nothing in `discord.js`
runs — no socket opens, no request leaves the server — unless the matching
environment variables are set on the host.

## Why it's safe to leave in the tree

The Chief's concern is a bot that gets raided or nuked. Two things address it:

1. **No credential ever lives in the app.** Every token and secret is read from
   `process.env` inside `discord.js` and nowhere else. There is no API route
   that accepts, returns, or logs one; nothing under `data/` stores one; and no
   dashboard field can set one. A compromised admin account cannot make this
   server talk to Discord, cannot repoint it at another guild, and cannot read
   the token back out. Turning it on is a Railway environment change, which
   only the deploy owner can make.
2. **The bot is the last layer, not the first.** Account linking and role sync
   work over OAuth with no bot in the guild at all. You can run those and leave
   the gateway permanently dark.

## The three layers

Each is independent and off unless its own variables exist.

### 1. Account linking — no bot required

```
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://your-site/api/discord/callback
```

Adds a "Connect your Discord" button to the dashboard. The member authorises
with `identify` + `guilds.members.read`; the server reads their id, username,
and guild roles, stores the id/username/roles on their user record, and throws
the access token away immediately. Tokens are never persisted, so a database
read cannot replay anyone's Discord session.

Create the app at <https://discord.com/developers/applications> → OAuth2, and
add the redirect URI there exactly as set above.

### 2. Role → permission sync

```
DISCORD_GUILD_ID=...
```

With the guild id set, roles map to site permissions through the **Discord**
panel in the dashboard (stored in `data/discord.json` — role ids and labels
only, no secrets, safe to edit). Permissions are the union of every matched
role.

`role: "admin"` is deliberately never granted by a Discord role. A role edit can
hand out `canEditRoster` or `canOnboard`, but minting a site admin stays a
deliberate human action.

### 3. Bot gateway — the part that can stay dark forever

```
DISCORD_BOT_TOKEN=...
DISCORD_NOTIFY_CHANNEL_ID=...     # optional, enables channel notifications
```

Connects to the Discord gateway (raw WebSocket, no `discord.js` dependency) and
watches `GUILD_MEMBER_ADD/UPDATE/REMOVE`. Requires the **Server Members
Intent** enabled in the developer portal, or no member events arrive.

What it does when on:

| Event | Behaviour |
|---|---|
| Member gains a mapped rank role, no roster entry | Fills a vacant slot of that rank. Never invents a callsign — with no vacant slot it posts a notice instead. |
| Member's mapped rank role changes | Updates their roster rank, resets promotion date, posts the change. |
| Member loses all mapped roles | Vacates their roster slot ("auto-resign"). |
| Member leaves the guild | Vacates their roster slot. |

Every one of these writes goes through the same `withWriteLock` queue as a
human edit and is recorded in the roster audit log as `system:discord`, so a
bot-driven change is never indistinguishable from a staff one.

## Per-feature kill switches

Individual behaviours can be disabled without pulling the whole integration —
set any of these to `false`:

```
DISCORD_AUTO_ADD_RECRUITS=false
DISCORD_AUTO_RESIGN=false
DISCORD_NOTIFICATIONS=false
DISCORD_PERMISSION_SYNC=false
```

This is how you'd run notifications only: the bot posts rank changes to a
channel but never writes to the roster.

## Turning it off

Remove the environment variables and redeploy. With `DISCORD_BOT_TOKEN` gone,
`startBot()` returns `false` and no socket is opened. Existing account links
stay on user records and are harmless; the Discord panel shows every layer as
off. The dashboard's Discord panel always shows current live state, so you can
confirm what is and isn't running at a glance.
