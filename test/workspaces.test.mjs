// Workspace isolation test — each workspace is a fully separate company.
// Requires a running Bureau server. Uses ONLY throwaway workspaces it creates and deletes; it never
// mutates the default workspace (only reads its counts to prove they don't change).
//   start:  BUREAU_PORT=4174 node server.mjs
//   run:    BUREAU_PORT=4174 node test/workspaces.test.mjs
import { readFileSync } from "node:fs";
import http from "node:http";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Bails out of the run with a REASON. Throws rather than calling process.exit(): every call site here is
// downstream of a fetch, and on Windows exiting while undici's handles are still closing trips a libuv
// assertion and kills the process with 0xC0000409 instead of the code being set — the same trap
// tools/heartbeat.mjs carries a note about. Measured here too: the first version of the read-only case
// below exited 3221226505 rather than 2, which would have reported this refusal as a crash.
class Bail extends Error {}
const die = (msg) => { console.error(`✗ workspaces.test.mjs cannot run against :${PORT} — ${msg}`); throw new Bail(); };
// Where the token above came from, so a refusal says which credential was tried and not just that one was.
const tokenSource = process.env.OPERATOR_TOKEN ? "OPERATOR_TOKEN" : (TOKEN ? "Latch's auth.json" : "nowhere — no token was found at all");

(async () => {
  // Every assertion below reads a company off the server, so a server that refuses this suite's credential
  // used to surface as `TypeError: Cannot read properties of undefined (reading 'length')` on the
  // .agents.length one line down. Measured: that is exactly what a second gate run produced when it found
  // a concurrent run's server already on the shared port and reused it without its disposable token. A
  // TypeError names the line that tripped and never the reason, so a port collision read as a source
  // regression. Diagnose instead — the status, the credential, and what to do about it.
  const baseline = await api("GET", "/api/org", null, "default");
  if (!Array.isArray(baseline.j?.agents)) {
    die(`GET /api/org answered ${baseline.status} with no company in the body`
      + ` (${String(baseline.j?.error || JSON.stringify(baseline.j)).slice(0, 90)}).`
      + ` The operator token came from ${tokenSource}.`
      + (baseline.status === 401 || baseline.status === 429
        ? ` That token is not this server's. If a concurrent test run booted it, the token is disposable and`
          + ` exists only inside that run — use \`node test/run-all.mjs --serve\`, which self-hosts on a free`
          + ` port of its own rather than sharing one.`
        : ``));
  }
  const before = baseline.j;
  const dAgents = before.agents.length, dPolicies = (before.policies || []).length;
  console.log(`default baseline: ${dAgents} agents, ${dPolicies} policies`);

  // create two throwaway workspaces
  const a = (await api("POST", "/api/workspaces", { name: "Test Alpha" })).j;
  const b = (await api("POST", "/api/workspaces", { name: "Test Beta" })).j;
  ok(a.id && b.id && a.id !== b.id, "two workspaces created with distinct ids");

  // A LAST-RESORT sweep. The deletes further down are assertions ABOUT the delete endpoint and stay where they
  // are; this is the net for everything above them throwing first. It has fired for real: a change made an
  // assertion near the top throw, the run died before reaching those deletes, and two companies sat in the
  // registry afterwards with nothing in the output to say so. Same lesson as the proseproof worktree leak in
  // tools/proseproof.mjs — cleanup that has never been watched is not cleanup.
  const sweep = async () => {
    for (const w of [a, b]) {
      if (!w || !w.id) continue;
      try { await api("DELETE", "/api/workspaces/" + w.id); } catch { /* already gone, or the server is down */ }
    }
  };

  // A missing id is not an assertion failure worth continuing past: every check below addresses a company
  // BY id, and an undefined id sends no x-workspace header at all — so the whole suite would run against
  // the DEFAULT company and report a dozen unrelated-looking failures. Sweeps first, because the
  // finally-sweep below is not reached from here and the other workspace may well have been created.
  if (!a.id || !b.id) {
    await sweep();
    die(`POST /api/workspaces returned no id (A: ${JSON.stringify(a).slice(0, 100)}, B: ${JSON.stringify(b).slice(0, 100)})`);
  }
  try {

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

  // An unknown workspace is REFUSED, not silently answered from the default company.
  //
  // This asserted the opposite — "falls back to default (never a phantom company)" — and that intent is right: a
  // header must not conjure a company. Refusing satisfies it just as well, because refusing creates nothing
  // either, and it does not carry what the fallback carried. Measured: an experiment ran two arms under
  // `x-workspace: cov-on` and `cov-off`, neither of which existed. Both wrote guardrails, an agent allow list and
  // a budget onto the DEFAULT company; both ran there; the second overwrote the first; and every readback
  // confirmed the settings, because the readback landed in the same place. $1.40 of model time bought a
  // comparison of a company with itself, and every response was a 200. On a live deployment the same typo
  // reconfigures the real company rather than a throwaway.
  {
    const r = await api("GET", "/api/org", null, "no-such-ws-xyz");
    ok(r.status === 400, `unknown workspace id is refused rather than served from default (got ${r.status})`);
    ok(/no workspace/i.test(r.j.error || ""), "and the refusal says which name was not found");
    ok((await orgOf("default")).agents.length === dAgents, "default is untouched by the refused request");
  }
  // The control: a workspace that DOES exist still resolves, so the guard is not refusing everything.
  ok((await orgOf(a.id)).agents.length === 2, "a real workspace id still resolves to its own company");

  // A run that ends abnormally must still be accounted for. Both of these fail before any LLM call, so
  // they belong in the model-free suite — and B is empty, which is exactly the precondition. Before the
  // fix, POST /api/run answered 201 and then left NOTHING: no /api/runs entry, no audit row, budget.runs
  // still 0. Worst on the unattended paths, where a schedule whose agent was deleted no-ops forever and
  // the audit log agrees nothing happened.
  const auditRuns = async (ws) => ((await api("GET", "/api/audit", null, ws)).j.audit || []).filter((x) => x.kind === "run");
  const waitForRunRows = async (ws, n) => {
    for (let i = 0; i < 25; i++) { const rows = await auditRuns(ws); if (rows.length >= n) return rows; await sleep(200); }
    return auditRuns(ws);
  };
  const noRoster = await api("POST", "/api/run", { mode: "company", objective: "Write a status note.", autoApprove: true }, b.id);
  ok(noRoster.status === 201 && noRoster.j.runId, "a company run against an empty roster is accepted (201)");
  const rows1 = await waitForRunRows(b.id, 1);
  ok(rows1.length === 1 && rows1[0].verdict === "error", "…and audited as a failed run (it used to leave no trace at all)");
  ok(/no agents|no roster/i.test(rows1[0]?.error || ""), "the audit row says WHY it failed, not just that it did");
  ok(((await api("GET", "/api/runs", null, b.id)).j.runs || []).length === 1, "the failed run is listed in /api/runs");
  const orgB = await orgOf(b.id);
  ok((orgB.budget?.runs || 0) === 1, "org.budget.runs counts the failed run");
  ok((orgB.activity || [])[0]?.verdict === "error", "org.activity records it as an error");

  const ghost = await api("POST", "/api/run", { mode: "single", agentId: "agent_deleted_yesterday", objective: "Do the thing.", autoApprove: true }, b.id);
  const rows2 = await waitForRunRows(b.id, 2);
  ok(rows2.length === 2, "a single run naming a deleted agent is audited too");
  ok(/agent_deleted_yesterday/.test((rows2.find((x) => x.runId === ghost.j.runId) || {}).error || ""), "and the row names the agent that was missing");
  ok((await orgOf(b.id)).agents.length === 0, "neither failed run invented an agent in B");

  // /stop used to answer {ok:true} for any id at all, including one that never existed.
  ok((await api("POST", "/api/run/nope_run/stop", {}, b.id)).status === 404, "stop: unknown run → 404 (it used to claim ok:true)");

  // ---- the notification webhook, the one path whose whole job is to reach an absent operator -------
  // It was fire-and-forget in the strongest sense: `.catch(() => {})` around a fetch whose response was
  // never read. Measured before changing — a webhook on a closed port stayed completely silent (0 audit
  // rows, /api/notify still reporting the URL as if healthy) and an HTTP 500 was indistinguishable from
  // success. Uses a throwaway workspace so the real default webhook is never touched.
  const hits = [];
  let sinkMode = "ok";
  const sink = http.createServer((rq, rs) => {
    let buf = ""; rq.on("data", (d) => (buf += d));
    rq.on("end", () => { try { hits.push(JSON.parse(buf || "{}")); } catch { hits.push({}); }
      if (sinkMode === "500") { rs.writeHead(500); rs.end("no"); } else { rs.writeHead(200); rs.end("{}"); } });
  });
  await new Promise((r) => sink.listen(0, "127.0.0.1", r));
  const SINK = `http://127.0.0.1:${sink.address().port}/hook`;
  try {
    ok((await api("POST", "/api/notify/test", {}, b.id)).status === 400, "notify: test with no webhook configured → 400, not a silent no-op");
    await api("POST", "/api/notify", { webhook: SINK }, b.id);
    const t1 = await api("POST", "/api/notify/test", {}, b.id);
    ok(t1.status === 200 && t1.j.ok === true, "notify: test reports a real success");
    ok(hits.length === 1 && hits[0].event === "test", "notify: and the endpoint actually received the test event");
    ok((await api("GET", "/api/notify", null, b.id)).j.lastDelivery?.ok === true, "notify: GET reports the last delivery outcome");

    await api("POST", "/api/notify", { webhook: "http://127.0.0.1:1/gone" }, b.id);
    const t2 = await api("POST", "/api/notify/test", {}, b.id);
    ok(t2.status === 502 && t2.j.ok === false, "notify: an unreachable endpoint reports 502, not success");
    ok((await api("GET", "/api/notify", null, b.id)).j.lastDelivery?.ok === false, "notify: a failing webhook no longer looks identical to a healthy one");
    const nrows = ((await api("GET", "/api/audit", null, b.id)).j.audit || []).filter((x) => x.kind === "notify");
    ok(nrows.some((r) => !r.ok), "notify: the failure is queryable as a kind=\"notify\" audit row (there were none at all before)");

    sinkMode = "500"; hits.length = 0;
    await api("POST", "/api/notify", { webhook: SINK }, b.id);
    const t3 = await api("POST", "/api/notify/test", {}, b.id);
    ok(hits.length === 1 && t3.j.ok === false && /HTTP 500/.test(t3.j.error || ""), "notify: HTTP 500 is a failed delivery, not a delivered one");

    // The completion path always pushed run_done; failure pushed nothing — the event you'd most want.
    sinkMode = "ok"; hits.length = 0;
    await api("POST", "/api/notify", { webhook: SINK }, b.id);
    await api("POST", "/api/run", { mode: "company", objective: "Write a status note.", autoApprove: true }, b.id);
    for (let i = 0; i < 40 && !hits.length; i++) await sleep(150);
    ok(hits.length === 1 && hits[0].event === "run_failed", "notify: a FAILED run now pushes run_failed (it used to push nothing)");
    ok(/no agents|no roster/i.test(hits[0]?.error || ""), "notify: and the push carries the reason it failed");
  } finally { sink.close(); await api("POST", "/api/notify", { webhook: "" }, b.id); }

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
  // Can't be asserted by querying the deleted id — that is a 400 now, because the id names a workspace that no
  // longer exists; before the guard it fell back to `default` and would have read the default company's rows.
  // Either way the deleted id cannot answer for itself, so the delete reports its own sweep instead.
  ok(delA.j.removed && typeof delA.j.removed.embeddingRows === "number", "delete reports embedding rows swept (this table was silently exempt before)");
  ok(delA.j.removed && typeof delA.j.removed.auditRows === "number", "delete reports audit rows swept");
  ok((await api("DELETE", "/api/workspaces/default")).status === 400, "the default workspace cannot be deleted");

  const end = await orgOf("default");
  ok(end.agents.length === dAgents && (end.policies || []).length === dPolicies, "default fully intact at the end");

  // The sweep must run whether the body above passed, failed an assertion, or threw. It is idempotent: the
  // deletes above have usually already removed both, and a second DELETE of a gone id is a 404, not an error.
  } finally { await sweep(); }

  console.log(`\n${fail.length ? "FAILURES ✗" : "ALL PASS ✓"} — ${pass.length} passed, ${fail.length} failed`);
  pass.forEach((m) => console.log("  ✓ " + m));
  fail.forEach((m) => console.log("  ✗ " + m));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  // A Bail already printed its own diagnosis; anything else is a genuine harness error and keeps the
  // stack. Both set the code and RETURN rather than calling process.exit() — see the note on `die`.
  if (!(e instanceof Bail)) console.error("HARNESS ERROR:", e);
  process.exitCode = 2;
});
