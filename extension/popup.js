const $ = (id) => document.getElementById(id);
let tabId = null;
let tabUrl = "";

function send(msg) {
  return chrome.runtime.sendMessage({ ...msg, tabId });
}

function fmt(s) {
  if (!Number.isFinite(s)) return "--:--";
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

function setFriend(text, cls) {
  $("friend").textContent = text;
  $("friend").className = cls || "";
}

async function refresh() {
  const st = await send({ type: "status" });
  if (!st) return;

  $("enabled").checked = st.enabled;

  // The server is asked for once: only when the build has none and it isn't working yet.
  $("server-box").hidden = st.serverBuiltIn || (!!st.serverUrl && st.connected);
  if (document.activeElement !== $("server")) $("server").value = st.serverUrl.replace(/^wss:\/\//, "");
  $("room").textContent = st.room.match(/.{1,4}/g).join("-");

  const others = st.peers - 1;
  if (!st.serverUrl) setFriend("Enter your server address first", "wait");
  else if (!st.enabled) setFriend("Sync is off");
  else if (!st.connected) setFriend("Connecting…", "wait");
  else if (others < 1) setFriend("Friend is offline", "wait");
  else if (!st.friends.length) setFriend(others === 1 ? "Friend is online, not on a page yet" : `${others} friends online, not on a page yet`, "ok");
  else setFriend(others === 1 ? "Friend is online" : `${others} friends online`, "ok");
  renderFriends(st.enabled && st.connected ? st.friends : [], st);

  // Sharing makes this tab the one the friends see (and syncs once a video plays).
  const isWeb = /^https?:/.test(tabUrl);
  const sharedHere = !!(st.activeHere && st.myPage);
  $("share-box").hidden = !(st.enabled && st.connected && isWeb);
  $("share").hidden = sharedHere;
  $("shared").hidden = !sharedHere;

  const v = st.video;
  $("video").textContent = v
    ? `${v.paused ? "Paused" : "Playing"} · ${fmt(v.t)} / ${fmt(v.duration)}`
    : "No video found yet. Start the player first.";
  $("elsewhere").hidden = !(v && st.enabled && !st.activeHere);

  // The browser's autoplay rules can block a synced play; tell the user the one click needed.
  const notices = {
    muted: "Your browser started the video muted. Turn the sound on in the player.",
    blocked: "Press play on the video once to join your friend.",
  };
  const notice = v && st.activeHere ? notices[v.notice] : "";
  $("notice").hidden = !notice;
  $("notice").textContent = notice || "";

}

// One row per friend who is on a page: "with you", or a link that takes this tab there.
function renderFriends(friends, st) {
  const rows = friends.map((f) => {
    const li = document.createElement("li");
    if (f.samePage) {
      li.className = "ok";
      li.textContent = st.video ? `Watching together · ${st.rttMs} ms` : "On the same page";
    } else if (f.url) {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = `${f.title || f.page} ↗`;
      a.title = f.url;
      a.addEventListener("click", (e) => goToFriend(e, f.peerId));
      li.append("On: ", a);
    }
    return li;
  });
  const key = JSON.stringify(rows.map((li) => li.outerHTML));
  if ($("friends").dataset.key === key) return; // keep links stable while hovering
  $("friends").dataset.key = key;
  $("friends").replaceChildren(...rows.filter((li) => li.firstChild));
}

function editRoom(on) {
  $("room-view").hidden = on;
  $("room-edit").hidden = !on;
  $("room-input").value = "";
  if (on) $("room-input").focus();
}

async function goToFriend(e, peerId) {
  e.preventDefault();
  const res = await send({ type: "go-to-friend", peerId });
  if (res && res.error) $("error").textContent = res.error;
  else window.close();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  tabUrl = tab && tab.url ? tab.url : "";

  $("enabled").addEventListener("change", async () => {
    await send({ type: "set-enabled", value: $("enabled").checked });
    refresh();
  });
  $("save-server").addEventListener("click", async () => {
    const res = await send({ type: "set-server", url: $("server").value });
    $("error").textContent = res && res.error ? res.error : "";
    refresh();
  });
  $("copy-room").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("room").textContent);
    $("copy-room").textContent = "Copied";
    setTimeout(() => ($("copy-room").textContent = "Copy"), 1500);
  });
  $("change-room").addEventListener("click", () => editRoom(true));
  $("cancel-room").addEventListener("click", () => editRoom(false));
  $("join-room").addEventListener("click", async () => {
    const res = await send({ type: "set-room", room: $("room-input").value });
    $("error").textContent = res && res.error ? res.error : "";
    if (!res || !res.error) editRoom(false);
    refresh();
  });
  $("room-input").addEventListener("keydown", (e) => e.key === "Enter" && $("join-room").click());
  $("share").addEventListener("click", async () => {
    const res = await send({ type: "share-page", url: tabUrl });
    $("error").textContent = res && res.error ? res.error : "";
    refresh();
  });

  refresh();
  setInterval(refresh, 500);
}

init();
