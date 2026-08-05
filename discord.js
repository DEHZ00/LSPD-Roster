// Discord integration — written in full, dormant by default.
//
// SECURITY MODEL (this is the part the Chief cares about):
//   Every credential is read from the process environment and nowhere else.
//   There is no API route that reads, writes, or echoes a token, no token in
//   any file under data/, and nothing in the dashboard that can change one.
//   A compromised admin account therefore cannot make this server talk to
//   Discord, cannot repoint it at another guild, and cannot read the token
//   back out. Turning the integration on or off is a Railway environment
//   change, which only the deploy owner can make.
//
// THREE INDEPENDENT LAYERS, each off unless its own vars are present:
//   1. OAuth account linking  — DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET
//                               (+ DISCORD_REDIRECT_URI)
//      Users click "Connect Discord", we read their id/username and (with the
//      guilds.members.read scope) their roles in the guild. No bot involved,
//      no gateway connection, nothing that can be raided or nuked.
//   2. Role -> permission sync — the above + DISCORD_GUILD_ID
//      Their guild roles map to site permissions via data/discord.json, which
//      is config only (role ids and names) and safe to edit in the dashboard.
//   3. Bot gateway            — DISCORD_BOT_TOKEN
//      Live rank-change watching, auto-adding recruits, auto-resigning on a
//      rank change, and channel notifications. This is the layer the Chief is
//      nervous about; with no DISCORD_BOT_TOKEN set, none of this code ever
//      opens a socket.
//
// Zero dependencies on purpose — Node 22 ships global fetch and WebSocket, so
// there is no discord.js in the tree and no supply chain to compromise.

const API_BASE = "https://discord.com/api/v10";
const OAUTH_SCOPES = ["identify", "guilds.members.read"];

// ── Configuration ──────────────────────────────────────────────────────────

// Never returns secrets — only whether each layer has what it needs. This is
// what the /api/discord/config route is allowed to send to a browser.
export function discordConfig() {
  const clientId = process.env.DISCORD_CLIENT_ID || "";
  const clientSecret = process.env.DISCORD_CLIENT_SECRET || "";
  const redirectUri = process.env.DISCORD_REDIRECT_URI || "";
  const guildId = process.env.DISCORD_GUILD_ID || "";
  const botToken = process.env.DISCORD_BOT_TOKEN || "";
  const notifyChannelId = process.env.DISCORD_NOTIFY_CHANNEL_ID || "";

  const oauthEnabled = Boolean(clientId && clientSecret && redirectUri);
  const botEnabled = Boolean(botToken && guildId);

  return {
    oauthEnabled,
    roleSyncEnabled: oauthEnabled && Boolean(guildId),
    botEnabled,
    notifyEnabled: botEnabled && Boolean(notifyChannelId),
    clientId,          // public by design — it appears in the authorize URL
    redirectUri,
    guildId
  };
}

// Secrets stay in this module. Nothing exports them.
function secrets() {
  return {
    clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
    botToken: process.env.DISCORD_BOT_TOKEN || ""
  };
}

// Individual features can be switched off without pulling the whole
// integration, so notifications can run while roster writes stay manual.
export function featureSwitches() {
  const off = (name) => String(process.env[name] || "").toLowerCase() === "false";
  return {
    autoAddRecruits: !off("DISCORD_AUTO_ADD_RECRUITS"),
    autoResignOnRankChange: !off("DISCORD_AUTO_RESIGN"),
    channelNotifications: !off("DISCORD_NOTIFICATIONS"),
    permissionSync: !off("DISCORD_PERMISSION_SYNC")
  };
}

// ── OAuth account linking ──────────────────────────────────────────────────

// `refresh` is for someone who already linked and just wants their roles
// re-read. prompt=none skips the consent screen when the authorisation is
// still valid, so it's a redirect out and straight back rather than a form.
export function buildAuthorizeUrl(state, { refresh = false } = {}) {
  const { oauthEnabled, clientId, redirectUri } = discordConfig();
  if (!oauthEnabled) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    state,
    prompt: refresh ? "none" : "consent"
  });
  return `${API_BASE}/oauth2/authorize?${params}`;
}

async function discordFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(`Discord API ${response.status}: ${body.slice(0, 200)}`);
    error.statusCode = response.status === 429 ? 429 : 502;
    throw error;
  }
  return response.json();
}

// The access token returned here is used immediately and thrown away — it is
// never persisted, so a database read can't replay someone's Discord session.
export async function exchangeCode(code) {
  const { oauthEnabled, clientId, redirectUri } = discordConfig();
  if (!oauthEnabled) throw new Error("Discord OAuth is not configured.");
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secrets().clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });
  const token = await discordFetch(`${API_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  return token.access_token;
}

export async function fetchIdentity(accessToken) {
  const me = await discordFetch(`${API_BASE}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  return { id: me.id, username: me.username, globalName: me.global_name || me.username };
}

// Roles come from the user's own OAuth grant, so this works with no bot in the
// guild at all. Returns [] when role sync isn't configured.
export async function fetchGuildRoles(accessToken) {
  const { guildId, roleSyncEnabled } = discordConfig();
  if (!roleSyncEnabled) return [];
  try {
    const member = await discordFetch(`${API_BASE}/users/@me/guilds/${guildId}/member`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    return Array.isArray(member.roles) ? member.roles : [];
  } catch {
    // Not in the guild, or the grant was declined — treat as no roles rather
    // than failing the whole link.
    return [];
  }
}

// ── Role -> permission / rank mapping ──────────────────────────────────────

// Shape of data/discord.json (config only, no secrets — safe to edit in the UI):
//   {
//     "roleMap": [
//       { "roleId": "123", "label": "Command",
//         "permissions": { "canEditRoster": true, "canManageUsers": true,
//                          "canOnboard": true, "canManageRanks": false },
//         "rank": "Captain" }
//     ],
//     "notifyChannelId": ""     // display only; the real one is an env var
//   }
export function defaultDiscordSettings() {
  return { roleMap: [], updatedAt: null, updatedBy: "system:seed" };
}

export function sanitizeDiscordSettings(input) {
  const roleMap = (Array.isArray(input?.roleMap) ? input.roleMap : []).slice(0, 100).map((row) => ({
    roleId: String(row?.roleId || "").trim().slice(0, 25),
    label: String(row?.label || "").trim().slice(0, 60),
    permissions: {
      canEditRoster: Boolean(row?.permissions?.canEditRoster),
      canManageUsers: Boolean(row?.permissions?.canManageUsers),
      canOnboard: Boolean(row?.permissions?.canOnboard),
      canManageRanks: Boolean(row?.permissions?.canManageRanks)
    },
    rank: String(row?.rank || "").trim().slice(0, 60)
  })).filter((row) => /^\d{5,25}$/.test(row.roleId));
  return { roleMap };
}

// Permissions are the union of every matched role — a member with two mapped
// roles gets both. Deliberately never grants `role: "admin"`; site admin stays
// something a human sets by hand, so a Discord role edit can't mint one.
export function permissionsForRoles(roleIds, settings) {
  const granted = {
    canEditRoster: false,
    canManageUsers: false,
    canOnboard: false,
    canManageRanks: false
  };
  let matched = false;
  let rank = "";
  for (const row of settings?.roleMap || []) {
    if (!roleIds.includes(row.roleId)) continue;
    matched = true;
    for (const key of Object.keys(granted)) {
      if (row.permissions?.[key]) granted[key] = true;
    }
    if (row.rank && !rank) rank = row.rank;
  }
  return { matched, permissions: granted, rank };
}

// ── Bot gateway (inert without DISCORD_BOT_TOKEN) ──────────────────────────

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// GUILDS | GUILD_MEMBERS — GUILD_MEMBERS is privileged and must be enabled in
// the Discord developer portal before member updates arrive.
const INTENTS = (1 << 0) | (1 << 1);

let socket = null;
let heartbeatTimer = null;
let reconnectDelay = 5000;
let sessionState = { id: null, seq: null, resumeUrl: null };
let handlers = {};
let stopped = true;

// Called from server.js at boot. Returns false and does nothing at all when
// the bot token is absent, which is the default deployment.
export function startBot(eventHandlers = {}) {
  const { botEnabled } = discordConfig();
  if (!botEnabled) return false;
  handlers = eventHandlers;
  stopped = false;
  connectGateway();
  return true;
}

export function stopBot() {
  stopped = true;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (socket) {
    try { socket.close(1000); } catch { /* already closing */ }
  }
  socket = null;
}

function connectGateway() {
  if (stopped) return;
  const url = sessionState.resumeUrl || GATEWAY_URL;
  socket = new WebSocket(url);

  socket.addEventListener("message", (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.s !== null && payload.s !== undefined) sessionState.seq = payload.s;
    handleGatewayPayload(payload);
  });

  socket.addEventListener("close", () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (stopped) return;
    // Exponential backoff capped at 5 minutes so a Discord outage doesn't
    // turn into a reconnect storm from every running instance.
    setTimeout(connectGateway, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 300000);
  });

  socket.addEventListener("error", () => { /* close handler does the retry */ });
}

function gatewaySend(payload) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
}

function handleGatewayPayload(payload) {
  switch (payload.op) {
    case 10: { // HELLO
      const interval = payload.d.heartbeat_interval;
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => gatewaySend({ op: 1, d: sessionState.seq }), interval);
      if (sessionState.id) {
        gatewaySend({ op: 6, d: { token: secrets().botToken, session_id: sessionState.id, seq: sessionState.seq } });
      } else {
        gatewaySend({
          op: 2,
          d: {
            token: secrets().botToken,
            intents: INTENTS,
            properties: { os: "linux", browser: "pd-roster", device: "pd-roster" }
          }
        });
      }
      break;
    }
    case 9: // INVALID SESSION — start clean
      sessionState = { id: null, seq: null, resumeUrl: null };
      setTimeout(connectGateway, 2000);
      break;
    case 0: // DISPATCH
      if (payload.t === "READY") {
        reconnectDelay = 5000;
        sessionState.id = payload.d.session_id;
        sessionState.resumeUrl = `${payload.d.resume_gateway_url}/?v=10&encoding=json`;
        console.log(`Discord bot connected as ${payload.d.user?.username}.`);
      }
      if (payload.t === "GUILD_MEMBER_UPDATE") handlers.onMemberUpdate?.(payload.d);
      if (payload.t === "GUILD_MEMBER_ADD") handlers.onMemberAdd?.(payload.d);
      if (payload.t === "GUILD_MEMBER_REMOVE") handlers.onMemberRemove?.(payload.d);
      break;
    default:
      break;
  }
}

// ── Bot REST helpers ───────────────────────────────────────────────────────

export async function sendChannelMessage(content, { channelId, mentionUserId } = {}) {
  const { notifyEnabled } = discordConfig();
  if (!notifyEnabled || !featureSwitches().channelNotifications) return false;
  const target = channelId || process.env.DISCORD_NOTIFY_CHANNEL_ID;
  const body = {
    content: mentionUserId ? `<@${mentionUserId}> ${content}` : content,
    allowed_mentions: { users: mentionUserId ? [mentionUserId] : [] }
  };
  try {
    await discordFetch(`${API_BASE}/channels/${target}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${secrets().botToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    return true;
  } catch (error) {
    console.error("Discord notification failed:", error.message);
    return false;
  }
}

// Which mapped roles a member gained or lost, used to decide whether a
// GUILD_MEMBER_UPDATE is actually a rank change worth acting on.
export function diffMappedRoles(previousRoleIds, nextRoleIds, settings) {
  const mapped = new Set((settings?.roleMap || []).map((row) => row.roleId));
  const before = new Set((previousRoleIds || []).filter((id) => mapped.has(id)));
  const after = new Set((nextRoleIds || []).filter((id) => mapped.has(id)));
  return {
    gained: [...after].filter((id) => !before.has(id)),
    lost: [...before].filter((id) => !after.has(id))
  };
}

