// Launches an isolated Chrome profile with the extension loaded unpacked.
// Branded Chrome ignores --load-extension, so the extension is installed over
// the CDP pipe (Extensions.loadUnpacked). The process stays alive to keep the
// pipe open; a TCP debugging port is exposed for tools/cdp.mjs.
//
// usage: node tools/launch-chrome.mjs <name> <port> <windowX>
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [name = "a", port = "9301", x = "0"] = process.argv.slice(2);
const chrome =
  process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = resolve(root, ".profiles", name);
mkdirSync(profile, { recursive: true });

const proc = spawn(
  chrome,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-position=${x},40`,
    "--window-size=960,860",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
);

const toChrome = proc.stdio[3];
const fromChrome = proc.stdio[4];
let buffer = "";
fromChrome.on("data", (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.id === 1) {
      if (msg.error) console.log(`[${name}] loadUnpacked failed: ${JSON.stringify(msg.error)}`);
      else console.log(`[${name}] extension loaded: ${msg.result.id} (port ${port})`);
    }
  }
});

function loadExtension() {
  toChrome.write(
    JSON.stringify({
      id: 1,
      method: "Extensions.loadUnpacked",
      params: { path: resolve(root, "extension") },
    }) + "\0",
  );
}
loadExtension();
// `kill -USR2 <pid>` reinstalls the extension after code changes
// (chrome.runtime.reload() would drop a pipe-loaded extension).
process.on("SIGUSR2", loadExtension);
console.log(`[${name}] launcher pid ${process.pid}`);

proc.on("exit", (code) => {
  console.log(`[${name}] chrome exited (${code})`);
  process.exit(0);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => proc.kill());
