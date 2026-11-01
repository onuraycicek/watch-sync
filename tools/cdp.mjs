// Minimal raw CDP client for driving the test browsers. It deliberately avoids
// enabling the Debugger/Runtime domains on pages, so sites with anti-devtools
// traps behave as they do for a normal user.
//
// usage: node tools/cdp.mjs <port> <command> [args]
//   tabs                     list targets
//   open <url>               open a new tab, prints targetId
//   nav <targetId> <url>     navigate a tab
//   front <targetId>         bring a tab to front
//   close <targetId>         close a tab
//   eval <targetId> <expr>   evaluate in the tab's top frame
//   click <targetId> <x> <y> real mouse click (counts as a user gesture)
//   key <targetId> <key>     press a key (e.g. " " or "Escape")
//   shot <targetId> <file>   save a PNG screenshot
//   sw <expr>                evaluate in the extension service worker
const [port, cmd, ...args] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;

const { webSocketDebuggerUrl } = await (await fetch(`${base}/json/version`)).json();
const socket = new WebSocket(webSocketDebuggerUrl);
await new Promise((ok, fail) => {
  socket.onopen = ok;
  socket.onerror = fail;
});

let nextId = 0;
const waiting = new Map();
socket.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const w = waiting.get(msg.id);
  if (!w) return;
  waiting.delete(msg.id);
  msg.error ? w.fail(new Error(JSON.stringify(msg.error))) : w.ok(msg.result);
};

function call(method, params = {}, sessionId) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((ok, fail) => waiting.set(id, { ok, fail }));
}

async function attach(targetId) {
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
}

async function evaluate(sessionId, expression) {
  const res = await call(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: false },
    sessionId,
  );
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || "eval failed");
  return res.result.value;
}

const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

try {
  switch (cmd) {
    case "tabs": {
      const { targetInfos } = await call("Target.getTargets");
      for (const t of targetInfos) console.log(`${t.targetId}  ${t.type.padEnd(14)} ${t.url.slice(0, 140)}`);
      break;
    }
    case "open":
      out((await call("Target.createTarget", { url: args[0] })).targetId);
      break;
    case "nav": {
      const s = await attach(args[0]);
      out(await call("Page.navigate", { url: args[1] }, s));
      break;
    }
    case "close":
      await call("Target.closeTarget", { targetId: args[0] });
      break;
    case "front":
      await call("Target.activateTarget", { targetId: args[0] });
      break;
    case "eval":
      out(await evaluate(await attach(args[0]), args[1]));
      break;
    case "click": {
      const s = await attach(args[0]);
      const x = Number(args[1]);
      const y = Number(args[2]);
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, s);
      await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, s);
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, s);
      break;
    }
    case "key": {
      const s = await attach(args[0]);
      const key = args[1];
      await call("Input.dispatchKeyEvent", { type: "keyDown", key, text: key.length === 1 ? key : undefined }, s);
      await call("Input.dispatchKeyEvent", { type: "keyUp", key }, s);
      break;
    }
    case "shot": {
      const s = await attach(args[0]);
      const { data } = await call("Page.captureScreenshot", { format: "png" }, s);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(args[1], Buffer.from(data, "base64"));
      out(args[1]);
      break;
    }
    case "sw": {
      const { targetInfos } = await call("Target.getTargets");
      const sw = targetInfos.find(
        (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"),
      );
      if (!sw) throw new Error("extension service worker not running");
      out(await evaluate(await attach(sw.targetId), args[0]));
      break;
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  socket.close();
}
