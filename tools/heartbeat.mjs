// Dead-man's switch: prove Bureau can still do its job, then report that to an EXTERNAL watcher.
//
// Why external: Bureau's own notification webhook (`notify.webhook`) only fires from inside a finishing
// run, so a crashed server, a failed boot or a dead Ollama sends nothing at all — and that silence is
// indistinguishable from "no runs happened". A watcher that expects a regular ping and alerts when the
// pings STOP is the only shape that survives the monitored machine dying.
//
// Why it generates instead of pinging a port: this repo already learned that the hard way. With the
// Ollama tray updater having deleted llama-server.exe, `/api/tags` still answered from memory while
// every inference 500'd — ports, model list and the installer's own verify were all green. A liveness
// check that only proves a process is LISTENING misses a service that has lost the ability to work.
//
// Config (never committed): heartbeat.local.json  { "url": "https://hc-ping.com/<uuid>" }
//   or env HEALTHCHECK_URL. The ping URL is a bearer secret — anyone holding it can forge liveness.
//
// Exit codes:  0 = healthy, ping sent   1 = unhealthy, /fail sent   2 = could not report at all
//
// NB the code sets process.exitCode and RETURNS -- it must never call process.exit() after a fetch.
// On Windows that trips a libuv assertion (!(handle->flags & UV_HANDLE_CLOSING), async.c:94) because
// undici's handles are still closing, and the process dies with 0xC0000409 instead of the code above.
// A HEALTHY machine would then report a crash to the task scheduler. Measured, not theoretical.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const stamp = () => new Date().toISOString();
const log = (m) => console.log(`${stamp()} ${m}`);

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch { return null; } };

// --- config -----------------------------------------------------------------
const local = readJson(join(ROOT, "heartbeat.local.json")) || {};
const HC_URL = (process.env.HEALTHCHECK_URL || local.url || "").trim();
const BUREAU = process.env.BUREAU_URL || `http://127.0.0.1:${process.env.BUREAU_PORT || 4173}`;
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS) || 45000;

// A SYSTEM scheduled task has homedir C:\Windows\system32\config\systemprofile, so LATCH_DATA must be
// passed explicitly by the installer — the same trap that makes a naive "just make it a service" fail.
const latchData = process.env.LATCH_DATA || join(ROOT, "..", "openclaw-command-center", "data");
const TOKEN = process.env.OPERATOR_TOKEN || (readJson(join(latchData, "auth.json")) || {}).operatorToken || "";

const withTimeout = async (fn) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try { return await fn(ac.signal); } finally { clearTimeout(t); }
};

async function main() {
if (!HC_URL) { log("FATAL no healthcheck URL (heartbeat.local.json .url or HEALTHCHECK_URL)"); return 2; }

// --- checks -----------------------------------------------------------------
const failures = [];
let modelName = "";

// 1. Bureau answers an AUTHENTICATED request and reports itself ok.
try {
  const r = await withTimeout((signal) => fetch(`${BUREAU}/api/health`, {
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}, signal,
  }));
  if (r.status === 401 || r.status === 403) failures.push(`bureau auth rejected (${r.status}) - token rotated without restarting Bureau?`);
  else if (!r.ok) failures.push(`bureau /api/health HTTP ${r.status}`);
  else {
    const h = await r.json();
    modelName = h.model || "";
    if (!h.ok) failures.push(`bureau reports ok=false`);
    if (h.enabled === false) failures.push(`bureau model provider disabled`);
  }
} catch (e) { failures.push(`bureau unreachable: ${e.name === "AbortError" ? "timeout" : e.message}`); }

// 2. The model can actually PRODUCE A TOKEN. Not "is the port open", not "is it in /api/tags".
if (modelName) {
  try {
    const r = await withTimeout((signal) => fetch(`${OLLAMA}/api/generate`, {
      method: "POST", signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelName, prompt: "ok", stream: false, options: { num_predict: 1 } }),
    }));
    if (!r.ok) failures.push(`ollama generate HTTP ${r.status} for ${modelName}`);
    else {
      const g = await r.json();
      if (!g.response && !g.done) failures.push(`ollama returned no token for ${modelName}`);
    }
  } catch (e) { failures.push(`ollama generate failed: ${e.name === "AbortError" ? "timeout" : e.message}`); }
} else if (!failures.length) {
  failures.push("could not determine the configured model from /api/health");
}

// --- report -----------------------------------------------------------------
const healthy = failures.length === 0;
const target = healthy ? HC_URL : `${HC_URL.replace(/\/+$/, "")}/fail`;
const body = healthy ? `ok model=${modelName}` : failures.join("; ");

try {
  const r = await withTimeout((signal) => fetch(target, {
    method: "POST", body: body.slice(0, 1000), headers: { "content-type": "text/plain" }, signal,
  }));
  log(`${healthy ? "HEALTHY" : "UNHEALTHY"} -> ${healthy ? "ping" : "/fail"} HTTP ${r.status} :: ${body}`);
  // Reporting is the job. If the watcher itself is unreachable we cannot escalate, but we must not
  // pretend success -- exit 2 makes it visible in the task's LastTaskResult.
  if (!r.ok) { log(`WARN watcher rejected the report (HTTP ${r.status})`); return 2; }
} catch (e) {
  log(`FATAL could not reach the watcher: ${e.name === "AbortError" ? "timeout" : e.message} :: ${body}`);
  return 2;
}

return healthy ? 0 : 1;
}

process.exitCode = await main();
