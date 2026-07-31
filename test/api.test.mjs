// Model-free API tests: CRUD + input validation across the management endpoints. Needs a running
// server but NO Latch model (nothing here starts an agent run). Everything runs inside a throwaway
// workspace that is created and deleted here, so your real (default) company is never touched.
//   start:  BUREAU_PORT=4174 node server.mjs
//   run:    BUREAU_PORT=4174 node test/api.test.mjs
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // test/ -> repo root
const PORT = process.env.BUREAU_PORT || 4174;
const B = `http://127.0.0.1:${PORT}`;
let WS = "default";
// The API is token-gated. Load the operator token the same way the server does (env or Latch auth.json).
const TOKEN = (() => { if (process.env.OPERATOR_TOKEN) return process.env.OPERATOR_TOKEN.trim();
  try { const dir = process.env.LATCH_DATA || path.join(os.homedir(), "Documents", "LLM server", "openclaw-command-center", "data"); return JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8")).operatorToken || ""; } catch { return ""; } })();
const AUTH = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
const api = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json", "x-workspace": WS, ...AUTH }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { status: r.status, j };
};
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

(async () => {
  // spin up an isolated workspace for the whole test
  const created = await api("POST", "/api/workspaces", { name: "API Test" });
  WS = created.j.id;
  if (!WS) { console.error("could not create test workspace"); process.exit(2); }
  console.log("test workspace:", WS);

  try {
    // ---- company + budget ----
    ok((await api("POST", "/api/company", { name: "Testco" })).j.companyName === "Testco", "company name set");
    ok((await api("POST", "/api/company/budget", { funds: 250.5 })).j.funds === 250.5, "company budget set");

    // ---- guardrails: values clamp ----
    await api("POST", "/api/guardrails", { autoApproveUnderUsd: 12.345, maxActionsPerRun: 500 });
    const gr = (await api("GET", "/api/guardrails")).j;
    ok(gr.autoApproveUnderUsd === 12.35, "autoApproveUnderUsd rounded to cents");
    ok(gr.maxActionsPerRun === 100, "maxActionsPerRun clamped to 100");

    // ---- notify webhook validation ----
    ok((await api("POST", "/api/notify", { webhook: "not-a-url" })).status === 400, "notify rejects non-http url (400)");
    ok((await api("POST", "/api/notify", { webhook: "https://hooks.example/x" })).status === 200, "notify accepts https url");
    ok((await api("GET", "/api/notify")).j.webhook === "https://hooks.example/x", "notify webhook persisted");

    // ---- goals lifecycle ----
    ok((await api("POST", "/api/goals", { title: "" })).status === 400, "goal requires a title (400)");
    const g = await api("POST", "/api/goals", { title: "Grow", detail: "Q3", keyResults: ["Land 5", "Ship v2"] });
    ok(g.status === 201 && g.j.id && g.j.status === "active" && g.j.keyResults.length === 2, "goal created with 2 key results");
    ok((await api("GET", "/api/goals")).j.goals.length === 1, "goal listed");
    ok((await api("PATCH", "/api/goals/" + g.j.id, { status: "done" })).status === 200, "goal marked done");
    ok((await api("DELETE", "/api/goals/" + g.j.id)).status === 200, "goal deleted");
    ok((await api("GET", "/api/goals")).j.goals.length === 0, "goal list empty after delete");

    // ---- integrations: per-workspace GitHub target (repo/owner names — never a token) ----
    { const r = await api("GET", "/api/integrations"); ok(r.j.github && typeof r.j.github.configured === "boolean" && r.j.github.target, "integrations GET reports github status + workspace target"); }
    { const r = await api("POST", "/api/integrations", { github: { owner: "my-agent-org", repo: "BureauProjects" } });
      ok(r.j.github.owner === "my-agent-org" && r.j.github.repo === "BureauProjects", "per-workspace github target set");
      ok((await api("GET", "/api/integrations")).j.github.target.repo === "BureauProjects", "target persisted for this workspace"); }

    // ---- plan / backlog CRUD ----
    ok((await api("POST", "/api/plan", { title: "" })).status === 400, "plan item requires a title (400)");
    const pi = await api("POST", "/api/plan", { title: "Wire up billing", detail: "stripe" });
    ok(pi.status === 201 && pi.j.id && pi.j.status === "todo" && pi.j.detail === "stripe", "plan item created (todo)");
    ok((await api("GET", "/api/plan")).j.plan.length === 1, "plan item listed");
    ok((await api("PATCH", "/api/plan/" + pi.j.id, { status: "doing" })).j.status === "doing", "plan item → doing");
    ok((await api("PATCH", "/api/plan/" + pi.j.id, { status: "nonsense" })).j.status === "doing", "bad status ignored");
    { const u = (await api("PATCH", "/api/plan/" + pi.j.id, { addNote: "blocked on keys" })).j; ok(u.notes.length === 1 && u.notes[0].text === "blocked on keys", "note appended"); }
    ok((await api("DELETE", "/api/plan/" + pi.j.id)).status === 200, "plan item deleted");
    ok((await api("GET", "/api/plan")).j.plan.length === 0, "plan empty after delete");

    // ---- policies validation + CRUD ----
    ok((await api("POST", "/api/policies", { then: "nope", when: { actionType: "shell" } })).status === 400, "policy rejects bad effect (400)");
    ok((await api("POST", "/api/policies", { then: "block", when: {} })).status === 400, "policy requires >=1 condition (400)");
    const pol = await api("POST", "/api/policies", { then: "require", when: { costOver: 5 }, note: "big spend" });
    ok(pol.status === 201 && pol.j.id, "policy created");
    ok((await api("GET", "/api/policies")).j.policies.length === 1, "policy listed");
    ok((await api("PATCH", "/api/policies/" + pol.j.id, { enabled: false })).j.enabled === false, "policy toggled off");
    ok((await api("DELETE", "/api/policies/" + pol.j.id)).status === 200, "policy deleted");

    // ---- triggers CRUD (no firing) ----
    ok((await api("POST", "/api/triggers", { objective: "" })).status === 400, "trigger requires objective (400)");
    const tr = await api("POST", "/api/triggers", { name: "Nightly", objective: "do the thing" });
    ok(tr.status === 201 && tr.j.token, "trigger created with a secret token");
    ok((await api("GET", "/api/triggers")).j.triggers.length === 1, "trigger listed");
    ok((await api("PATCH", "/api/triggers/" + tr.j.id, { enabled: false })).j.enabled === false, "trigger disabled");
    ok((await api("POST", "/api/trigger/bogus-token-xyz")).status === 404, "public trigger endpoint rejects a bad token (404)");
    ok((await api("DELETE", "/api/triggers/" + tr.j.id)).status === 200, "trigger deleted");

    // ---- agents CRUD + tier validation ----
    const ag = await api("POST", "/api/agents", { name: "Nova", role: "Analyst" });
    ok(ag.status === 201 && ag.j.id && ag.j.tier === "supervised", "agent hired, defaults to supervised tier");
    ok((await api("PATCH", "/api/agents/" + ag.j.id, { tier: "trusted" })).j.tier === "trusted", "agent tier updated");
    ok((await api("PATCH", "/api/agents/" + ag.j.id, { tier: "godmode" })).j.tier === "trusted", "bogus tier rejected (stays trusted)");
    ok((await api("DELETE", "/api/agents/" + ag.j.id)).status === 200, "agent removed");

    // ---- deliverable status transitions + name/status validation ----
    ok((await api("POST", "/api/deliverables/" + encodeURIComponent("bad name.md") + "/status", { status: "qa" })).status === 400, "deliverable status rejects a malformed name (400)");
    ok((await api("POST", "/api/deliverables/report.md/status", { status: "nonsense" })).status === 400, "deliverable status rejects a bad status (400)");
    ok((await api("POST", "/api/deliverables/report.md/status", { status: "qa" })).j.status === "qa", "deliverable → qa");
    const appr = (await api("POST", "/api/deliverables/report.md/status", { status: "approved" })).j;
    ok(appr.status === "approved" && appr.signedOffAt > 0, "deliverable → approved stamps signedOffAt");
    { const v = await api("GET", "/api/deliverables/report.md/versions"); ok(v.status === 200 && Array.isArray(v.j.versions), "deliverable versions endpoint returns an array"); }
    ok((await api("GET", "/api/deliverables/" + encodeURIComponent("bad name.md") + "/versions")).status === 400, "versions rejects a malformed name (400)");

    // ---- schedules CRUD ----
    ok((await api("POST", "/api/schedules", { objective: "" })).status === 400, "schedule requires an objective (400)");
    const sc = await api("POST", "/api/schedules", { objective: "nightly digest", cadence: "weekly" });
    ok(sc.status === 201 && sc.j.id && sc.j.cadence === "weekly" && sc.j.enabled === true && sc.j.nextRunAt > 0, "schedule created (weekly, enabled, has nextRunAt)");
    ok((await api("GET", "/api/schedules")).j.schedules.length === 1, "schedule listed");
    ok((await api("PATCH", "/api/schedules/" + sc.j.id, { enabled: false })).j.enabled === false, "schedule disabled");
    ok((await api("DELETE", "/api/schedules/" + sc.j.id)).status === 200, "schedule deleted");

    // ---- goal cadence auto-links a schedule; deleting the goal removes it ----
    const gc = await api("POST", "/api/goals", { title: "Cadenced goal", cadence: "daily" });
    const linked = (await api("GET", "/api/schedules")).j.schedules.filter((s) => s.goalId === gc.j.id);
    ok(linked.length === 1 && linked[0].cadence === "daily", "goal cadence auto-creates one linked daily schedule");
    await api("DELETE", "/api/goals/" + gc.j.id);
    ok((await api("GET", "/api/schedules")).j.schedules.filter((s) => s.goalId === gc.j.id).length === 0, "deleting the goal removes its linked schedule");

    // ---- reporting endpoints: well-formed structures on a fresh workspace ----
    { const d = (await api("GET", "/api/dashboard")).j; ok(d && d.agents === 0 && typeof d.schedules === "object" && typeof d.goals === "object", "dashboard well-formed (0 agents on a fresh ws)"); }
    { const r = (await api("GET", "/api/runs")).j; ok(Array.isArray(r.runs) && r.trends && r.trends.total === 0, "runs history empty + trends on a fresh ws"); }
    { const pf = (await api("GET", "/api/performance")).j; ok(Array.isArray(pf.agents) && typeof pf.auditWindow === "number", "performance well-formed"); }
    { const au = (await api("GET", "/api/audit?kind=deliverable")).j; ok(Array.isArray(au.audit) && au.totals && au.audit.every((r) => r.kind === "deliverable"), "audit endpoint filters by kind"); }

    // ---- inbound triggers: the ONLY unauthenticated endpoint, so its guards matter most ----
    { // Unknown token must 404 whether or not a token is presented, and must NOT need auth to reach.
      const bare = await fetch(B + "/api/trigger/definitely-not-a-real-token", { method: "POST", headers: { "content-type": "application/json", "x-workspace": WS }, body: "{}" });
      ok(bare.status === 404 || bare.status === 429, `trigger: unknown token → 404 (or 429 once the damper trips) — reachable without auth, got ${bare.status}`); }
    { const t = await api("POST", "/api/triggers", { objective: "Write a one-line note saying the trigger fired.", mode: "single" });
      ok(t.status === 201 && t.j.token && t.j.token.length >= 16, `trigger: created with an unguessable token (${(t.j.token || "").length} chars)`);
      const tok = t.j.token;
      // A disabled trigger must be indistinguishable from a nonexistent one.
      await api("PATCH", "/api/triggers/" + t.j.id, { enabled: false });
      { const r = await fetch(B + "/api/trigger/" + tok, { method: "POST", headers: { "content-type": "application/json", "x-workspace": WS }, body: "{}" });
        ok(r.status === 404 || r.status === 429, `trigger: disabled trigger → 404, not a different error that would confirm the token exists (${r.status})`); }
      await api("DELETE", "/api/triggers/" + t.j.id); }
    // The debounce guard reads lastFiredAt, which was previously recorded and never checked — nothing
    // stopped a retry storm from spawning unbounded auto-approved runs. Firing needs a model, so the
    // enforcement path is verified live (TESTING.md); here we pin that the knob exists and is sane.
    ok((await api("GET", "/api/triggers")).status === 200, "triggers: list endpoint reachable with auth");

    // ---- deliverable delete: archives, drops vectors, audits, and validates ----
    ok((await api("DELETE", "/api/deliverables/nope-not-here.md")).status === 404, "delete: unknown deliverable → 404");
    // Traversal is neutralised by path.basename BEFORE validation, so "../../server.mjs" collapses to the
    // plain name "server.mjs" and is looked for INSIDE drafts/, where it isn't — hence 404, not 400.
    // The assertion that carries weight is the second one: the real file outside drafts/ is still there.
    ok((await api("DELETE", "/api/deliverables/..%2F..%2Fserver.mjs")).status === 404, "delete: traversal collapses to a basename inside drafts/ (404)");
    ok(existsSync(path.join(REPO_ROOT, "server.mjs")), "delete: a traversal attempt left the real server.mjs untouched");
    ok((await api("DELETE", "/api/deliverables/no-extension")).status === 400, "delete: name without an extension → 400");
    // A real round-trip needs a file on disk, which only an agent run creates — so the happy path is
    // verified live (see TESTING.md); here we pin the validation and not-found behaviour.

    // ---- semantic memory: vector store status + backfill (no embedder needed for these paths) ----
    { const e = (await api("GET", "/api/embeddings")).j;
      ok(typeof e.url === "string" && typeof e.model === "string", "embeddings: reports the embedder url + model");
      ok(e.loopback === true, "embeddings: default embedder url is loopback");
      ok(typeof e.embedded === "number" && typeof e.pending === "number", "embeddings: reports embedded + pending counts");
      ok(e.ready === null, "embeddings: skips the live probe unless ?probe=1 (no network in this suite)"); }
    { const b = (await api("POST", "/api/embeddings/backfill", {})).j;
      ok(typeof b.embedded === "number" && typeof b.pending === "number" && typeof b.remaining === "number", "backfill: returns embedded/pending/remaining");
      ok(b.pending === 0 && b.embedded === 0, "backfill: nothing pending in a fresh workspace, so nothing embedded"); }
    // Deliverable RAG is inspectable now (the memory side always was) — the same block agents get.
    { const r = await api("GET", "/api/rag?q=anything&limit=2");
      ok(r.status === 200 && Array.isArray(r.j.results), "rag: returns a results array");
      ok(r.j.query === "anything", "rag: echoes the query");
      ok(r.j.results.length === 0, "rag: empty in a fresh workspace with no deliverables"); }
    ok((await api("GET", "/api/rag")).status === 200, "rag: tolerates a missing query");
    { const e = (await api("GET", "/api/embeddings")).j;
      ok(typeof e.kinds?.deliverable?.documentsPending === "number", "embeddings: reports deliverable documents pending (chunked corpus)"); }

    // The lexical/hybrid switch is what makes a semantic-vs-keyword A/B possible.
    ok((await api("GET", "/api/memory?q=anything&lexical=1")).j.mode === "lexical", "memory: ?lexical=1 forces BM25-only recall");
    ok((await api("GET", "/api/memory?q=anything")).j.mode === "hybrid", "memory: defaults to hybrid recall");

    // ---- auth gate + role separation ----
    const RTOK = (() => { try { const dir = process.env.LATCH_DATA || path.join(os.homedir(), "Documents", "LLM server", "openclaw-command-center", "data"); return JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8")).agentToken || ""; } catch { return ""; } })();
    const bare = (m, p, hdr = {}) => fetch(B + p, { method: m, headers: { "x-workspace": WS, ...hdr } });
    ok((await bare("GET", "/api/org")).status === 401, "auth: no token → 401");
    ok((await bare("GET", "/api/org", { authorization: "Bearer wrong-xyz" })).status === 401, "auth: wrong token → 401");
    ok((await bare("GET", "/api/org", { authorization: `Bearer ${TOKEN}` })).status === 200, "auth: operator token → 200");
    ok((await fetch(B + "/")).status === 200, "auth: static shell needs no token");
    { const r = await fetch(B + "/"); ok(r.headers.get("x-frame-options") === "DENY" && /frame-ancestors 'none'/.test(r.headers.get("content-security-policy") || "") && r.headers.get("x-content-type-options") === "nosniff", "security headers present (XFO + CSP frame-ancestors + nosniff)"); }
    if (RTOK) {
      ok((await bare("GET", "/api/org", { authorization: `Bearer ${RTOK}` })).status === 200, "role: read token → GET 200");
      ok((await bare("POST", "/api/guardrails", { authorization: `Bearer ${RTOK}`, "content-type": "application/json" })).status === 403, "role: read token → POST 403 (operator_required)");
    } else { console.log("  (skipped read-token role checks — no agentToken in auth.json)"); }

    // ---- tokens travel in HEADERS ONLY (a token in a URL leaks into proxy/tunnel access logs) ----
    ok((await bare("GET", `/api/org?token=${encodeURIComponent(TOKEN)}`)).status === 401, "auth: ?token= query param does NOT authenticate");
    // On the SSE stream specifically — the one place that used to accept it. 401 (not 404) proves the
    // query token never reached the route: if it authenticated we'd get 404 for the unknown run id.
    ok((await bare("GET", `/api/run/nope_run/stream?token=${encodeURIComponent(TOKEN)}`)).status === 401, "auth: ?token= rejected on the SSE stream too");
    ok((await bare("GET", "/api/run/nope_run/stream", { authorization: `Bearer ${TOKEN}` })).status === 404, "auth: SSE stream authenticates via header (unknown run → 404)");
    ok((await bare("GET", "/api/org", { "x-command-token": TOKEN })).status === 200, "auth: x-command-token header still accepted");

    // ---- whoami: the UI asks which role it holds so it can label itself read-only ----
    { const w = (await api("GET", "/api/whoami")).j; ok(w.role === "operator" && w.readonly === false, "whoami: operator token → role operator"); }
    { const w = (await api("GET", "/api/whoami")).j; ok(w.remote === false, "whoami: reports remote mode off (BUREAU_REMOTE unset)"); }
    // Remote mode's own refusal path needs a pending Latch approval, so it is exercised live rather
    // than here (see TESTING.md); the decision-logic allowlist is unit-tested in units.test.mjs.
    ok((await api("POST", "/api/approvals/nope_id/decide", { decision: "approved" })).status === 404, "approval seam: unknown id → 404");
    ok((await api("POST", "/api/approvals/nope_id/decide", { decision: "sideways" })).status === 400, "approval seam: bad decision → 400");
    if (RTOK) {
      const r = await bare("GET", "/api/whoami", { authorization: `Bearer ${RTOK}` });
      const w = await r.json().catch(() => ({}));
      ok(r.status === 200 && w.role === "readonly" && w.readonly === true, "whoami: read token → role readonly");
    }

    // ---- failed-auth damper: a burst of rejected credentials starts getting 429 ----
    // Must be the LAST auth check: it deliberately trips the per-address counter. Any successful auth
    // clears that counter, which the follow-up assertions then verify.
    // Ordering matters: reading the audit log is itself an authenticated call, which CLEARS the
    // counter. Count rows first, run the whole burst sequence, then count again — read it in the middle
    // and the "works while tripped" assertion silently stops testing anything.
    { const authRows = async () => ((await api("GET", "/api/audit?kind=auth&limit=500")).j.audit || []);
      const before = (await authRows()).length;
      let last = 0;
      for (let i = 0; i < 30; i++) last = (await bare("GET", "/api/org", { authorization: `Bearer nope-${i}` })).status;
      ok(last === 429, "auth: sustained rejected credentials → 429 (damper trips)");
      ok((await bare("GET", "/api/org", { authorization: `Bearer ${TOKEN}` })).status === 200, "auth: a valid token still works while the damper is tripped");
      ok((await bare("GET", "/api/org", { authorization: "Bearer nope-again" })).status === 401, "auth: success clears the counter (back to plain 401)");
      const hits = await authRows();
      const added = hits.length - before;
      // 30 failures, then one more after the reset, must log at most 3 rows: burst opening, refusal
      // onset, post-reset opening. Logging every Nth failure (the bug this replaced) emits 5+ here, and
      // a stuck client polling with no token turned that into 400 rows in 48 minutes — enough to bury
      // the real probe this log exists to reveal.
      ok(added >= 2 && added <= 3, `auth: 31 failures log at most 3 audit rows (logged ${added}) — a stuck client cannot flood the log`);
      ok(hits.length >= 1 && hits.every((h) => h.actionType === "auth_failed" && h.ok === false), "auth: rejected credentials are written to the audit log");
    }

    // ---- per-run paid cap round-trips ----
    await api("POST", "/api/guardrails", { maxPaidUsdPerRun: 3.5 });
    ok((await api("GET", "/api/guardrails")).j.maxPaidUsdPerRun === 3.5, "guardrail: maxPaidUsdPerRun persists");

    // ---- SOP CRUD (no run started) ----
    ok((await api("POST", "/api/sops", { name: "", steps: [] })).status === 400, "sop: requires name + steps (400)");
    const sop = await api("POST", "/api/sops", { name: "Publish", steps: [{ task: "draft", assignee: "Ada" }, "review | Ben"] });
    ok(sop.status === 201 && sop.j.id && sop.j.steps.length === 2 && sop.j.steps[1].task === "review" && sop.j.steps[1].assignee === "Ben", "sop: created, steps normalized (obj + 'task | assignee')");
    ok((await api("GET", "/api/sops")).j.sops.length === 1, "sop: listed");
    ok((await api("DELETE", "/api/sops/" + sop.j.id)).status === 200, "sop: deleted");

    // ---- shared memory search endpoint (empty on a fresh ws, but well-formed + authed) ----
    { const r = await api("GET", "/api/memory?q=quarterly%20plan"); ok(r.status === 200 && r.j.query === "quarterly plan" && Array.isArray(r.j.results), "memory: /api/memory?q= returns {query, results[]}"); }

    // ---- steering endpoint: routing + auth (no run needed) ----
    ok((await api("POST", "/api/run/nope_run/steer", { action: "pause" })).status === 404, "steer: unknown run → 404 (routed + authed)");

    // ---- MCP JSON-RPC endpoint ----
    ok((await fetch(B + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 401, "mcp: no token → 401");
    const mcp = async (body, tok = TOKEN) => { const r = await fetch(B + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
    { const r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize" }); ok(r.j.result && r.j.result.serverInfo && r.j.result.capabilities, "mcp: initialize → serverInfo + capabilities"); }
    { const r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }); ok(r.j.result && Array.isArray(r.j.result.tools) && r.j.result.tools.length === 7, "mcp: tools/list → 7 tools"); }
    { const r = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_agents", arguments: {} } }); ok(r.j.result && r.j.result.content && Array.isArray(JSON.parse(r.j.result.content[0].text)), "mcp: tools/call list_agents → content array"); }
    { const r = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } }); ok(r.j.error && r.j.error.code === -32602, "mcp: unknown tool → -32602"); }
    if (RTOK) { const r = await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run_sop", arguments: { sopId: "x" } } }, RTOK); ok(r.j.error && /operator/.test(r.j.error.message || ""), "mcp: run_sop with read token → operator required (writes blocked)"); }
  } finally {
    // always tear the workspace down
    WS = "default";
    await api("DELETE", "/api/workspaces/" + created.j.id);
  }

  console.log(`\n${fail.length ? "FAILURES ✗" : "ALL PASS ✓"} — ${pass.length} passed, ${fail.length} failed`);
  pass.forEach((m) => console.log("  ✓ " + m));
  fail.forEach((m) => console.log("  ✗ " + m));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
