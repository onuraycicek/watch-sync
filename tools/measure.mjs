// Measures the real gap between the two test browsers. Both run on this
// machine, so their Date.now() clocks match: each position is extrapolated to
// the same instant before comparing.
//
// usage: node tools/measure.mjs [samples=5] [intervalMs=1000]
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const [samples = 5, interval = 1000] = process.argv.slice(2).map(Number);
const expr = `Promise.resolve(activeTabId!=null&&mainFrame(activeTabId)).then(m=>m?chrome.tabs.sendMessage(activeTabId,{type:"get-snapshot"},{frameId:m.frameId}):null)`;

async function snap(port) {
  const { stdout } = await run("node", ["tools/cdp.mjs", String(port), "sw", expr]);
  return JSON.parse(stdout);
}

for (let i = 0; i < samples; i++) {
  const [a, b] = await Promise.all([snap(9301), snap(9302)]);
  if (!a || !b) {
    console.log("no video on one side");
  } else {
    const at = Math.max(a.at, b.at);
    const ta = a.t + (a.paused ? 0 : ((at - a.at) / 1000) * a.speed);
    const tb = b.t + (b.paused ? 0 : ((at - b.at) / 1000) * b.speed);
    const gap = Math.round((tb - ta) * 1000);
    console.log(
      `A ${a.paused ? "paused " : "playing"} ${ta.toFixed(3)} x${a.speed.toFixed(3)} | ` +
        `B ${b.paused ? "paused " : "playing"} ${tb.toFixed(3)} x${b.speed.toFixed(3)} | B-A ${gap > 0 ? "+" : ""}${gap} ms`,
    );
  }
  if (i < samples - 1) await new Promise((r) => setTimeout(r, interval));
}
