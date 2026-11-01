// Watch Sync background service worker. While sync is on, the worker stays
// connected to its room, tells the others which page it is on (the tab with a
// video, or one shared from the popup), and routes video state both ways. A live
// WebSocket keeps the MV3 worker alive (Chrome 116+).
//
// The relay address and the room come from config.js (written by `make`) when a
// build embeds them; otherwise the popup asks for the relay once and every
// install starts in its own random room, which friends join by entering its code.

// Written by `make`: self.WATCH_SYNC_CONFIG = { roomKey, serverUrl }. A plain
// checkout has none; the popup then asks for the server.
try {
  importScripts("config.js");
} catch {}

const CONFIG = self.WATCH_SYNC_CONFIG || {};
const KEEPALIVE_MS = 20000;
const TICK_MS = 2000;
const STALE_MS = 3500;

let enabled = true;
let serverUrl = "";
let roomKey = "";
let activeTabId = null; // the tab whose video is synced
let myPage = null; // { title, page, url } of the active tab
const friends = new Map(); // peerId -> { title, page, url } of their active tab
let myPeerId = "";
let leaderId = ""; // peer that acted last (drives drift correction); ours when we lead
let ws = null;
let wsOpen = false;
let peers = 0; // people in the room, including us
let rttMs = 200;
let pingSentAt = 0;
let leader = false; // the side that acted last drives drift correction
let needsSync = false;
let syncPendingUntil = 0; // while catching up with the others, local events are not sent
let retry = 0;
let reconnectTimer = null;
let clientId = ""; // stable per install: lets the server replace our own stale socket

const frames = new Map(); // tabId -> Map(frameId -> status)

const ready = (async () => {
  const local = await chrome.storage.local.get(["enabled", "clientId", "serverUrl", "roomKey"]);
  if (local.enabled === false) enabled = false;
  clientId = local.clientId || crypto.randomUUID();
  if (!local.clientId) await chrome.storage.local.set({ clientId });
  serverUrl = CONFIG.serverUrl || local.serverUrl || "";
  roomKey = local.roomKey || CONFIG.roomKey || "";
  if (!roomKey) {
    roomKey = randomRoom();
    await chrome.storage.local.set({ roomKey });
  }
  const session = await chrome.storage.session.get(["activeTabId", "leader"]);
  activeTabId = session.activeTabId ?? null;
  leader = !!session.leader;
  ensureConnection();
  updateUi();
})();

// Wake the worker with the browser so the others see us online right away.
chrome.runtime.onStartup.addListener(() => ready);
chrome.runtime.onInstalled.addListener(() => ready);

// ---------- room & relay ----------

const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes (0/O, 1/I)

function randomRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => ROOM_CHARS[b % ROOM_CHARS.length]).join("");
}

// Codes are shown in groups ("K7Q2-X9PA-..."); separators and case don't matter.
function normalizeRoom(code) {
  const room = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{8,64}$/.test(room) ? room : "";
}

// Accepts "relay.example.com", "https://relay.example.com/..." or "wss://...".
function normalizeServer(input) {
  let text = String(input || "").trim();
  if (!text) return "";
  if (!/^[a-z]+:\/\//i.test(text)) text = "wss://" + text;
  try {
    const u = new URL(text);
    const scheme = { "https:": "wss:", "wss:": "wss:", "http:": "ws:", "ws:": "ws:" }[u.protocol];
    return scheme ? `${scheme}//${u.host}` : "";
  } catch {
    return "";
  }
}

// A new room or relay: start over there.
function reconnect() {
  disconnect();
  setLeader(false);
  needsSync = true;
  ensureConnection();
}

// ---------- frames & pages ----------

function mainFrame(tabId) {
  const map = frames.get(tabId);
  if (!map) return null;
  const now = Date.now();
  let best = null;
  for (const [frameId, status] of map) {
    if (now - status.at > STALE_MS) {
      map.delete(frameId);
      continue;
    }
    if (!best || status.area > best.status.area) best = { frameId, status };
  }
  return best;
}

async function snapshotOf(tabId) {
  const main = mainFrame(tabId);
  if (!main) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "get-snapshot" }, { frameId: main.frameId });
  } catch {
    return null;
  }
}

function toMainFrame(tabId, msg) {
  const main = tabId == null ? null : mainFrame(tabId);
  if (!main) return false;
  chrome.tabs.sendMessage(tabId, msg, { frameId: main.frameId }).catch(() => {});
  return true;
}

// Same episode on both sides <=> same origin + path of the top page.
function pageKey(url) {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return url;
  }
}

// Only web pages are followed; anything else from the peer is dropped.
function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

function samePage(page) {
  return !!(page && myPage && page === myPage.page);
}

function friendList() {
  return [...friends].map(([peerId, f]) => ({ peerId, ...f, samePage: samePage(f.page) }));
}

async function refreshPage() {
  if (activeTabId == null) return;
  try {
    const tab = await chrome.tabs.get(activeTabId);
    myPage = { title: tab.title || "", page: pageKey(tab.url || ""), url: tab.url || "" };
  } catch {
    myPage = null;
  }
  sendHello();
}

function sendHello() {
  wsSend({ type: "hello", ...(myPage || { title: "", page: "", url: "" }) });
}

// `page` announces a known page instead of reading the tab (used when following
// the friend's link, before the navigation has happened).
async function setActiveTab(tabId, page) {
  if (activeTabId !== tabId) {
    activeTabId = tabId;
    chrome.storage.session.set({ activeTabId });
  } else if (!page) {
    return;
  }
  if (page) {
    myPage = page;
    sendHello();
  } else {
    await refreshPage();
  }
  updateUi();
}

// ---------- connection ----------

function shouldConnect() {
  return enabled && !!roomKey && !!serverUrl;
}

function ensureConnection() {
  if (shouldConnect()) connect();
  else disconnect();
}

function connect() {
  if (ws) return;
  clearTimeout(reconnectTimer);
  const socket = new WebSocket(`${serverUrl}/room/${roomKey}?id=${clientId}`);
  ws = socket;

  socket.onopen = () => {
    wsOpen = true;
    retry = 0;
    ping();
    sendHello();
    updateUi();
  };
  socket.onmessage = (ev) => onSocketMessage(ev.data);
  socket.onclose = (ev) => {
    if (ws !== socket) return;
    resetRoom();
    // 4000: this same install connected again elsewhere; that one wins.
    if (ev.code !== 4000 && shouldConnect()) {
      retry = Math.min(retry + 1, 6);
      reconnectTimer = setTimeout(connect, 500 * 2 ** retry);
    }
  };
}

function disconnect() {
  clearTimeout(reconnectTimer);
  if (!ws) return;
  const socket = ws;
  resetRoom();
  socket.close(1000, "idle");
}

function resetRoom() {
  ws = null;
  wsOpen = false;
  peers = 0;
  myPeerId = "";
  friends.clear();
  updateUi();
}

function wsSend(data) {
  if (ws && wsOpen) ws.send(typeof data === "string" ? data : JSON.stringify(data));
}

function ping() {
  pingSentAt = Date.now();
  wsSend("ping");
}

function setLeader(value, id = value ? myPeerId : "") {
  leaderId = id;
  if (leader === value) return;
  leader = value;
  chrome.storage.session.set({ leader });
}

// Whoever sends a real state (a user action, or the answer to a catch-up request
// when nobody leads) leads; everyone else follows. One side drives drift correction.
function sendState(reason, state, to) {
  if (!state) return;
  if (reason !== "tick") setLeader(true);
  wsSend({
    type: "state",
    reason,
    to,
    paused: state.paused,
    t: state.t,
    rate: state.rate,
    half: rttMs / 2,
    // ms since the position was read (snapshot -> socket), on this machine's clock
    age: state.at ? Math.max(0, Date.now() - state.at) : 0,
    page: myPage ? myPage.page : null,
  });
}

async function onSocketMessage(raw) {
  if (raw === "pong") {
    rttMs = Date.now() - pingSentAt;
    return;
  }
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case "welcome":
      peers = msg.peers;
      myPeerId = msg.peerId;
      if (leader) leaderId = myPeerId; // we led before reconnecting
      // Others were already here: ask for their position.
      if (peers >= 2) needsSync = true;
      trySync();
      break;
    case "peer-joined":
      peers = msg.peers;
      sendHello();
      break;
    case "peer-left":
      peers = msg.peers;
      friends.delete(msg.peerId);
      if (leaderId === msg.peerId) leaderId = "";
      break;
    case "hello":
      if (msg.page) friends.set(msg.from, { title: msg.title || "", page: msg.page, url: safeUrl(msg.url) });
      else friends.delete(msg.from);
      break;
    case "state": {
      if (!enabled || activeTabId == null) break;
      // Catch-up answers are for the one who asked, and only the first counts.
      if (msg.reason === "sync" && (msg.to !== myPeerId || !syncPendingUntil)) break;
      const same = !!(myPage && msg.page && msg.page === myPage.page);
      // Position only makes sense on the same episode; play/pause always mirrors.
      if (!same && (msg.reason === "tick" || msg.reason === "sync")) break;
      // Seconds the position is old by: sender pipeline + one-way network.
      // The content script adds the local hop using recvAt.
      const lat = ((msg.half ?? 100) + rttMs / 2 + (msg.age || 0)) / 1000;
      const recvAt = Date.now();
      if (msg.reason === "tick") {
        // Two leaders (both answered a catch-up): the smaller peer id keeps leading.
        if (leader && msg.from > myPeerId) break;
        setLeader(false, msg.from);
        // Leader heartbeat: followers close small gaps by nudging their speed.
        toMainFrame(activeTabId, { type: "drift", t: msg.t, rate: msg.rate, lat, recvAt });
        break;
      }
      setLeader(false, msg.from);
      if (msg.reason === "sync") syncPendingUntil = 0;
      toMainFrame(activeTabId, {
        type: "apply-state",
        paused: msg.paused,
        t: msg.t,
        rate: msg.rate,
        seek: same,
        lat,
        recvAt,
        // Paused: land on the same frame. Playing: seek only for clear gaps, the
        // heartbeat removes the rest smoothly.
        tolerance: msg.paused ? 0.04 : 0.3,
      });
      break;
    }
    case "state-request":
      // The leader answers; when nobody leads, everyone does and the asker takes the first.
      if (leaderId && !leader) break;
      if (enabled && activeTabId != null) sendState("sync", await snapshotOf(activeTabId), msg.from);
      break;
  }
  updateUi();
}

function trySync() {
  if (!needsSync || !wsOpen || peers < 2 || activeTabId == null) return;
  if (!mainFrame(activeTabId)) return;
  needsSync = false;
  syncPendingUntil = Date.now() + 2000;
  wsSend({ type: "state-request" });
}

setInterval(async () => {
  await ready;
  ensureConnection();
  if (ws) ping();
}, KEEPALIVE_MS);

// The leader periodically broadcasts its position so the follower can correct drift.
setInterval(async () => {
  await ready;
  if (!enabled || !leader || peers < 2 || activeTabId == null) return;
  const state = await snapshotOf(activeTabId);
  // No heartbeat while seeking or buffering: the position is not moving then.
  if (state && !state.paused && !state.busy) sendState("tick", state);
}, TICK_MS);

// ---------- ui ----------

function updateUi() {
  const main = activeTabId != null ? mainFrame(activeTabId) : null;
  let text = "";
  let color = "#6b7280";
  if (!enabled) text = "off";
  else if (main && main.status.notice) {
    // Autoplay was blocked on our side: the popup explains what to click.
    text = "!";
    color = "#dc2626";
  } else if (wsOpen && peers >= 2) {
    text = "on";
    color = "#1f9d55";
  } else if (ws) {
    text = "…";
    color = "#d97706";
  }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true;
});

async function handle(msg, sender) {
  await ready;
  const tabId = sender.tab ? sender.tab.id : msg.tabId;

  switch (msg.type) {
    // from content scripts
    case "frame-status": {
      if (!frames.has(tabId)) frames.set(tabId, new Map());
      const map = frames.get(tabId);
      if (msg.none) {
        map.delete(sender.frameId);
        if (tabId === activeTabId && !mainFrame(tabId)) needsSync = true;
        return null;
      }
      const hadVideo = !!mainFrame(tabId);
      const prevNotice = map.get(sender.frameId)?.notice || "";
      map.set(sender.frameId, { ...msg, at: Date.now() });
      if (tabId === activeTabId && prevNotice !== (msg.notice || "")) updateUi();
      // Adopt this tab if nothing (or a tab without video) is bound yet.
      if (activeTabId == null || (activeTabId !== tabId && !mainFrame(activeTabId))) {
        await setActiveTab(tabId);
      }
      if (tabId === activeTabId) {
        if (!hadVideo) {
          // New video (first open or next episode): catch up with the friend.
          needsSync = true;
          await refreshPage();
          updateUi();
        }
        ensureConnection();
        trySync();
      }
      return null;
    }
    case "local-state": {
      if (!enabled) return null;
      const main = mainFrame(tabId);
      if (!main || main.frameId !== sender.frameId) return null;
      if (tabId !== activeTabId) {
        // Pressing play in another video tab moves the sync there.
        if (!/play/.test(msg.reason)) return null;
        await setActiveTab(tabId);
      }
      // Starting the player while catching up must not rewind the friend.
      if (Date.now() < syncPendingUntil) return null;
      ensureConnection();
      sendState(msg.reason, msg);
      return null;
    }
    case "resync":
      if (tabId !== activeTabId) return null;
      syncPendingUntil = Date.now() + 2000;
      wsSend({ type: "state-request" });
      return null;

    // popup: tell the friend about this page before any video is playing
    case "share-page":
      if (!safeUrl(msg.url)) return { error: "Only web pages can be shared" };
      if (activeTabId === tabId) await refreshPage();
      else await setActiveTab(tabId);
      ensureConnection();
      return { shared: true };

    // from a friend's link in the popup
    case "go-to-friend": {
      const friend = friends.get(msg.peerId);
      if (!friend || !friend.url) return { error: "Friend's page is unknown" };
      // Following the link joins the friend: this tab is announced as being there.
      await setActiveTab(tabId, { ...friend });
      await chrome.tabs.update(tabId, { url: friend.url });
      return { url: friend.url };
    }

    // from the popup (or test tooling)
    case "status": {
      const main = mainFrame(tabId);
      return {
        enabled,
        serverUrl,
        serverBuiltIn: !!CONFIG.serverUrl,
        room: roomKey,
        connected: wsOpen,
        peers,
        friends: friendList(),
        activeHere: activeTabId === tabId,
        myPage,
        rttMs,
        video: main ? { frameId: main.frameId, ...main.status } : null,
      };
    }
    case "set-enabled":
      enabled = !!msg.value;
      await chrome.storage.local.set({ enabled });
      if (!enabled) {
        disconnect();
      } else {
        needsSync = true;
        ensureConnection();
      }
      updateUi();
      return { enabled };
    case "set-room": {
      const room = normalizeRoom(msg.room);
      if (!room) return { error: "A room code is 8 to 64 letters and digits." };
      if (room !== roomKey) {
        roomKey = room;
        await chrome.storage.local.set({ roomKey });
        reconnect();
      }
      return { room };
    }
    case "set-server": {
      if (CONFIG.serverUrl) return { error: "This build has a fixed server." };
      const url = normalizeServer(msg.url);
      if (!url) return { error: "Enter the address of your Watch Sync server." };
      if (url !== serverUrl) {
        serverUrl = url;
        await chrome.storage.local.set({ serverUrl });
        reconnect();
      }
      return { serverUrl };
    }
    // test hook used by tools/cdp.mjs; behaves like a user action in the page
    case "control":
      return { sent: toMainFrame(tabId, { type: "control", action: msg.action, delta: msg.delta }) };
  }
  return null;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  frames.delete(tabId);
  if (tabId !== activeTabId) return;
  activeTabId = null;
  myPage = null;
  chrome.storage.session.set({ activeTabId });
  // Hand over to another tab that still has a video, if any.
  for (const id of frames.keys()) {
    if (mainFrame(id)) {
      await setActiveTab(id);
      break;
    }
  }
  if (activeTabId == null) sendHello(); // the friends' link to us disappears
  updateUi();
});

// Leaving the shared page withdraws it, so browsing elsewhere is never broadcast.
// A page is announced again when its video starts or it is shared from the popup.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  await ready;
  // A new page (e.g. the next episode) brings a new video: forget the old one's
  // frames so it is announced and caught up like a first open.
  if (info.url) frames.delete(tabId);
  if (tabId !== activeTabId || !myPage) return;
  if (info.url && pageKey(info.url) !== myPage.page) {
    myPage = null;
    sendHello();
    updateUi();
  } else if (info.title && pageKey(tab.url || "") === myPage.page) {
    refreshPage().then(updateUi);
  }
});
