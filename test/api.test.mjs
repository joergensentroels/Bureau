// Model-free API tests: CRUD + input validation across the management endpoints. Needs a running
// server but NO Latch model (nothing here starts an agent run). Everything runs inside a throwaway
// workspace that is created and deleted here, so your real (default) company is never touched.
//   start:  BUREAU_PORT=4174 node server.mjs
//   run:    BUREAU_PORT=4174 node test/api.test.mjs
const PORT = process.env.BUREAU_PORT || 4174;
const B = `http://127.0.0.1:${PORT}`;
let WS = "default";
const api = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json", "x-workspace": WS }, body: body ? JSON.stringify(body) : undefined });
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
