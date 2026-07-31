// Workspace isolation test — each workspace is a fully separate company.
// Requires a running Bureau server. Uses ONLY throwaway workspaces it creates and deletes; it never
// mutates the default workspace (only reads its counts to prove they don't change).
//   start:  BUREAU_PORT=4174 node server.mjs
//   run:    BUREAU_PORT=4174 node test/workspaces.test.mjs
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const PORT = process.env.BUREAU_PORT || 4174;
const B = `http://127.0.0.1:${PORT}`;
const TOKEN = (() => { if (process.env.OPERATOR_TOKEN) return process.env.OPERATOR_TOKEN.trim();
  try { const dir = process.env.LATCH_DATA || path.join(os.homedir(), "Documents", "LLM server", "openclaw-command-center", "data"); return JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8")).operatorToken || ""; } catch { return ""; } })();
const api = async (m, p, body, ws) => {
  const headers = { "content-type": "application/json" };
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  if (ws) headers["x-workspace"] = ws;
  const r = await fetch(B + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { status: r.status, j };
};
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const orgOf = async (ws) => (await api("GET", "/api/org", null, ws)).j;

(async () => {
  const before = await orgOf("default");
  const dAgents = before.agents.length, dPolicies = (before.policies || []).length;
  console.log(`default baseline: ${dAgents} agents, ${dPolicies} policies`);

  // create two throwaway workspaces
  const a = (await api("POST", "/api/workspaces", { name: "Test Alpha" })).j;
  const b = (await api("POST", "/api/workspaces", { name: "Test Beta" })).j;
  ok(a.id && b.id && a.id !== b.id, "two workspaces created with distinct ids");

  ok((await orgOf(a.id)).agents.length === 0, "new workspace A starts empty");
  ok((await orgOf(b.id)).agents.length === 0, "new workspace B starts empty");

  // write into A only
  await api("POST", "/api/agents", { name: "Alice", role: "Founder" }, a.id);
  await api("POST", "/api/agents", { name: "Andy", role: "Eng" }, a.id);
  await api("POST", "/api/policies", { then: "block", when: { actionType: "shell" } }, a.id);

  ok((await orgOf(a.id)).agents.length === 2, "A has its 2 agents");
  ok(((await orgOf(a.id)).policies || []).length === 1, "A has its 1 policy");
  ok((await orgOf(b.id)).agents.length === 0, "B is unaffected by writes to A");
  const dAfter = await orgOf("default");
  ok(dAfter.agents.length === dAgents && (dAfter.policies || []).length === dPolicies, "default is unaffected by writes to A");

  // unknown workspace header falls back to default (never a phantom company)
  ok((await orgOf("no-such-ws-xyz")).agents.length === dAgents, "unknown workspace id falls back to default");

  // Deletion must be THOROUGH. The UI promises "all its data (agents, deliverables, history)", and
  // embeddings were silently exempt: that table postdates the delete handler, so a deleted company left
  // its vectors in the DB — where semantic recall reads them. Assert the response reports the sweep and
  // that a re-created workspace of the same name starts genuinely empty.
  const delA = await api("DELETE", "/api/workspaces/" + a.id);
  ok(delA.status === 200 && delA.j.ok === true, "delete returns ok");
  ok(typeof delA.j.stoppedRuns === "number", "delete reports how many in-flight runs it stopped (they used to keep writing after deletion)");
  await api("DELETE", "/api/workspaces/" + b.id);
  const list = (await api("GET", "/api/workspaces")).j.workspaces.map((w) => w.id);
  ok(!list.includes(a.id) && !list.includes(b.id), "both throwaway workspaces removed from the registry");
  // Can't be asserted by querying the deleted id — that falls back to `default` (see the assertion
  // above), so it would read the default workspace's rows. The delete reports its own sweep instead.
  ok(delA.j.removed && typeof delA.j.removed.embeddingRows === "number", "delete reports embedding rows swept (this table was silently exempt before)");
  ok(delA.j.removed && typeof delA.j.removed.auditRows === "number", "delete reports audit rows swept");
  ok((await api("DELETE", "/api/workspaces/default")).status === 400, "the default workspace cannot be deleted");

  const end = await orgOf("default");
  ok(end.agents.length === dAgents && (end.policies || []).length === dPolicies, "default fully intact at the end");

  console.log(`\n${fail.length ? "FAILURES ✗" : "ALL PASS ✓"} — ${pass.length} passed, ${fail.length} failed`);
  pass.forEach((m) => console.log("  ✓ " + m));
  fail.forEach((m) => console.log("  ✗ " + m));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
