// Watch Sync content script. Runs in every frame (cross-origin player iframes
// included), picks the main <video>, reports its state to the background and
// applies state coming from the peer. It draws nothing on the page; anything the
// user must know (e.g. autoplay was blocked) goes to the popup via the background.
(() => {
  if (window.__watchSyncLoaded) return;
  window.__watchSyncLoaded = true;

  const MIN_DURATION = 90; // shorter videos are treated as ads or previews
  const MIN_AREA = 160 * 90;
  const REPORT_MS = 1000;
  const ECHO_WINDOW_MS = 1500;
  const COALESCE_MS = 150;
  // Drift correction: small gaps are closed by nudging the playback rate (no
  // rebuffering, pitch is preserved); only large gaps are seeked.
  const DRIFT_SEEK_S = 1.5;
  const DRIFT_DEADBAND_S = 0.02;
  const NUDGE_WINDOW_S = 1.5; // close a gap within this time (heartbeat is 2 s)
  const NUDGE_MIN = 0.01; // ±1% .. ±8% speed
  const NUDGE_MAX = 0.08;

  let video = null;
  let echo = null; // state we expect after applying a remote command
  let pendingEvents = [];
  let flushTimer = null;
  let reportedNone = true;
  let mutedBySync = false; // the browser blocked sound, so we started muted
  let blockedPlay = false; // even muted play was blocked: waiting for a click
  let baseRate = 1; // the speed the users chose; nudges are relative to it
  let ownRate = null; // last playbackRate we set ourselves (not a user action)
  let nudgeTimer = null;

  // ---------- messaging ----------

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // Extension was reloaded; this script is orphaned.
      stop();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "apply-state":
        applyRemote(msg);
        break;
      case "drift":
        correctDrift(msg);
        break;
      case "control":
        control(msg);
        break;
      case "get-snapshot":
        sendResponse(video ? snapshot() : null);
        break;
    }
  });

  // ---------- video discovery ----------

  function collectVideos(root, out) {
    for (const v of root.querySelectorAll("video")) out.push(v);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) collectVideos(el.shadowRoot, out);
    }
    return out;
  }

  function area(v) {
    const r = v.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  function eligible(v) {
    return Number.isFinite(v.duration) && v.duration >= MIN_DURATION && area(v) >= MIN_AREA;
  }

  function pickVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of collectVideos(document, [])) {
      if (!eligible(v)) continue;
      const a = area(v);
      if (a > bestArea) {
        best = v;
        bestArea = a;
      }
    }
    return best;
  }

  const EVENTS = ["play", "pause", "seeked", "ratechange"];

  function attach(v) {
    if (video === v) return;
    if (video) for (const e of EVENTS) video.removeEventListener(e, onLocalEvent);
    video = v;
    if (video) for (const e of EVENTS) video.addEventListener(e, onLocalEvent);
  }

  function snapshot() {
    return {
      paused: video.paused,
      t: video.currentTime,
      rate: baseRate,
      duration: video.duration,
      busy: video.seeking || video.readyState < 3, // seeking or buffering
      speed: video.playbackRate, // actual speed, including a running nudge
      at: Date.now(),
      notice: blockedPlay ? "blocked" : mutedBySync && video.muted ? "muted" : "",
    };
  }

  function setRate(rate) {
    clearTimeout(nudgeTimer);
    if (Math.abs(video.playbackRate - rate) < 1e-4) return;
    ownRate = rate;
    video.playbackRate = rate;
  }

  function report() {
    attach(pickVideo());
    if (video) {
      reportedNone = false;
      send({ type: "frame-status", ...snapshot(), area: area(video), href: location.href });
    } else if (!reportedNone) {
      reportedNone = true;
      send({ type: "frame-status", none: true });
    }
  }

  // ---------- local events -> peer ----------

  function isEcho(type) {
    if (!echo || performance.now() > echo.until) return false;
    if (type === "play") return !echo.paused;
    if (type === "pause") return echo.paused;
    if (type === "seeked") return Math.abs(video.currentTime - echo.t) < 1.5;
    return false;
  }

  function onLocalEvent(e) {
    if (!video) return;
    if (e.type === "ratechange") {
      if (ownRate !== null && Math.abs(video.playbackRate - ownRate) < 1e-4) return;
      baseRate = video.playbackRate; // the user picked a new speed
      ownRate = null;
    }
    if (e.type === "play" && blockedPlay) {
      // The user's click that unblocked playback: join the friend's position
      // instead of pushing ours.
      blockedPlay = false;
      send({ type: "resync" });
      return;
    }
    if (e.type !== "ratechange" && isEcho(e.type)) return;
    pendingEvents.push(e.type);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, COALESCE_MS);
  }

  function flush() {
    if (!video || !pendingEvents.length) return;
    const reason = pendingEvents.join(",");
    pendingEvents = [];
    setRate(baseRate); // a user action ends any running nudge
    send({ type: "local-state", reason, ...snapshot() });
  }

  // ---------- peer -> local video ----------

  // Total age of a received position: network/sender part plus our local hop.
  function ageOf(lat, recvAt) {
    return lat + (recvAt ? Math.max(0, Date.now() - recvAt) / 1000 : 0);
  }

  function applyRemote({ paused, t, rate, seek = true, lat = 0, recvAt, tolerance = 0.5 }) {
    if (!video) return;
    lat = ageOf(lat, recvAt);
    const target = paused ? t : t + lat * (rate || 1);
    echo = { until: performance.now() + ECHO_WINDOW_MS, paused, t: target };
    if (rate) baseRate = rate;
    setRate(baseRate); // any running nudge ends here
    if (seek && Math.abs(video.currentTime - target) > tolerance) video.currentTime = target;
    if (paused && !video.paused) video.pause();
    if (!paused && video.paused) playWithFallback();
  }

  // Autoplay with sound needs a click inside this frame. Muted playback is
  // always allowed, so keep the sync going muted; the user unmutes in the player.
  function playWithFallback() {
    video.play().then(
      () => (blockedPlay = false),
      (err) => {
        if (!err || err.name !== "NotAllowedError" || !video) return;
        video.muted = true;
        mutedBySync = true;
        video.play().then(
          () => (blockedPlay = false),
          () => (blockedPlay = true),
        );
      },
    );
  }

  // Leader heartbeat: steer towards the leader's position.
  function correctDrift({ t, rate, lat = 0, recvAt }) {
    if (!video || video.paused || video.seeking || video.readyState < 3) return;
    if (rate) baseRate = rate;
    lat = ageOf(lat, recvAt);
    const drift = t + lat * baseRate - video.currentTime; // > 0: we are behind
    if (Math.abs(drift) > DRIFT_SEEK_S) {
      echo = { until: performance.now() + ECHO_WINDOW_MS, paused: false, t: t + lat * baseRate };
      setRate(baseRate);
      video.currentTime = t + lat * baseRate;
      return;
    }
    if (Math.abs(drift) < DRIFT_DEADBAND_S) {
      setRate(baseRate);
      return;
    }
    // Run slightly fast/slow for exactly as long as it takes to close the gap,
    // then return to normal speed on our own (no overshoot between heartbeats).
    const offset = Math.max(NUDGE_MIN, Math.min(NUDGE_MAX, Math.abs(drift) / NUDGE_WINDOW_S));
    setRate(baseRate * (1 + Math.sign(drift) * offset));
    const ms = (Math.abs(drift) / (offset * baseRate)) * 1000;
    nudgeTimer = setTimeout(() => video && setRate(baseRate), ms);
  }

  // Test hook (tools/cdp.mjs via the background); behaves exactly like a user action.
  function control({ action, delta }) {
    if (!video) return;
    if (action === "play") playWithFallback();
    else if (action === "pause") video.pause();
    else if (action === "seek") video.currentTime = Math.max(0, video.currentTime + delta);
  }

  // ---------- loop ----------

  const timer = setInterval(report, REPORT_MS);
  report();

  function stop() {
    clearInterval(timer);
    attach(null);
  }
})();
