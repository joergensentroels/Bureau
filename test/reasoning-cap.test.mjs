// Does the thinking cap actually reach the provider?
//
// Everything else about this is asserted structurally — that the turn loop calls ask(2600, NO_THINKING), that
// askLlm spreads the fields, that Latch allowlists them. Structural assertions are how a chain of three correct
// links still fails: each one is checked against the file it lives in, and nobody checks the chain.
//
// So this runs the real chain. A throwaway Latch with a mock provider that RECORDS what it was handed, and
// Bureau's own askLlm imported from server.mjs — no live instance, no real API key, no money.
//
// Why the cap exists: a scoped hunting round spent 29,125 of its 29,246 output tokens on reasoning and returned
// 121 tokens of content across twelve calls. Eleven turns in a row came back empty and the run finished "clean".
// Raising the output budget, which is what the retry used to do, buys more reasoning and never content.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// fileURLToPath, not URL.pathname. On Windows the latter yields "/C:/Users/..." and every path built from it is
// silently wrong — the spawn just fails to start and the only symptom is a health check that never passes.
const LATCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "openclaw-command-center");
let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; console.log("✓ " + name); } else { fail++; console.log("✗ " + name); } };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Latch is a SEPARATE repository, and a Bureau clone (or CI) need not have it beside this one. Skipping LOUDLY
// rather than passing quietly: "nothing ran" and "everything passed" must never print the same thing.
if (!existsSync(path.join(LATCH, "server.js"))) {
  console.log("SKIPPED — no Latch checkout at " + LATCH);
  console.log("  This suite needs the openclaw-command-center repo beside bureau/, because it exercises the real");
  console.log("  chain Bureau -> Latch -> provider. NOTHING WAS VERIFIED HERE. The unit suites still cover each");
  console.log("  link on its own; what goes unproven without this is that the three of them agree.");
  process.exit(0);
}

const dataDir = await mkdtemp(path.join(tmpdir(), "bureau-cap-"));
const latchPort = String(25500 + Math.floor(Math.random() * 1500));
const llmPort = String(27500 + Math.floor(Math.random() * 1500));
const agentToken = "agent_cap_test";

// The mock provider. Records every payload; answers with content so askLlm resolves.
const seen = [];
const mockLlm = http.createServer(async (req, res) => {
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let raw = ""; for await (const c of req) raw += c;
    seen.push(raw ? JSON.parse(raw) : {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "mock", choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
    }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => mockLlm.listen(Number(llmPort), "127.0.0.1", r));

const latch = spawn(process.execPath, ["server.js"], {
  cwd: LATCH,
  env: { ...process.env, DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: latchPort,
         OPERATOR_TOKEN: "op_cap_test", AGENT_TOKEN: agentToken,
         LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
         LLM_MODEL: "mock-model", LLM_API_KEY: "mock-key", LLM_TIMEOUT_MS: "8000" },
  stdio: ["ignore", "pipe", "pipe"],
});
latch.stdout.on("data", () => {});
let latchErr = ""; latch.stderr.on("data", (c) => { latchErr += c; });

try {
  const deadline = Date.now() + 10000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { up = (await (await fetch(`http://127.0.0.1:${latchPort}/api/health`)).json()).ok; } catch { await delay(150); }
  }
  if (!up) throw new Error("throwaway Latch never became healthy\n" + latchErr);

  // Bureau reads LATCH_URL and its token at module load, so both are set BEFORE the import.
  process.env.LATCH_URL = `http://127.0.0.1:${latchPort}`;
  process.env.LATCH_TOKEN = agentToken;
  process.env.OPERATOR_TOKEN = agentToken;
  const { askLlm, NO_THINKING, initLatchAuth } = await import("../server.mjs");
  // TOKEN is populated by the server bootstrap, which does NOT run on a plain import — without this every call
  // goes out as "Bearer undefined" and Latch answers 401. The empty `seen` array said only "no request arrived".
  await initLatchAuth();

  const opts = { maxTokens: 64, routingPreference: "external" };
  const before = seen.length;
  let firstErr = null;
  await askLlm([{ role: "user", content: "hi" }], opts).catch((e) => { firstErr = e; });
  if (firstErr) console.log("    (first call error: " + firstErr.message.slice(0, 160) + ")");
  const plain = seen[before];
  chk("  the chain reaches the provider at all", !!plain);
  if (plain) {
    // The baseline. Without it, "absent" below could mean "absent from every request".
    chk("  an ordinary call carries no reasoning fields",
        !("reasoning_effort" in plain) && !("thinking" in plain));
  }

  const at = seen.length;
  let capErr = null;
  await askLlm([{ role: "user", content: "hi" }], { ...opts, ...NO_THINKING }).catch((e) => { capErr = e; });
  if (capErr) console.log("    (capped call error: " + capErr.message.slice(0, 160) + ")");
  const capped = seen[at];
  chk("  the capped call reached the provider", !!capped);
  if (capped) {
    // These are the bytes the provider received, having crossed Bureau's askLlm, Latch's allowlist and the
    // payload builder. Three links, checked as one.
    chk("  reasoning_effort arrived, snake_cased by Latch", capped.reasoning_effort === "minimal");
    chk("  and the thinking block arrived intact",
        capped.thinking && capped.thinking.type === "disabled");
    chk("  while the rest of the request is unchanged",
        capped.model === "mock-model" && Array.isArray(capped.messages) && capped.messages.length > 0);
  }
} catch (e) {
  fail++; console.log("✗ harness error: " + e.message);
} finally {
  latch.kill("SIGTERM");
  await new Promise((r) => { latch.on("exit", r); setTimeout(r, 3000); });
  await new Promise((r) => mockLlm.close(r));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

console.log(fail ? `\nFAILURES ✗ — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
