// Live end-to-end test: does the safe-autonomy stack COMPOSE in a real company run?
//   tier auto-approve  →  policy `require` override  →  in-app approval seam  →  DoD verdict  →  policy `block`
//
// Requires a running Bureau server AND a reachable Latch backend + local model.
//   start:  BUREAU_PORT=4174 node server.mjs
//   run:    BUREAU_PORT=4174 node test/e2e-autonomy.mjs      (defaults to 4174)
//
// The runs are real: they create deliverables in drafts/ and may file/resolve Latch approvals.
// The test cleans up its own policies, agent tier, drafts, and any approval it files.
const PORT = process.env.BUREAU_PORT || 4174;
const B = `http://127.0.0.1:${PORT}`;
const api = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { status: r.status, j };
};
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const evCounts = (evs) => { const c = {}; for (const e of evs) c[e.type] = (c[e.type] || 0) + 1; return JSON.stringify(c); };

// Stream a run's SSE events; auto-approve the plan gate so an attended run proceeds to work.
async function runAndStream(spec, onEvent, ms = 160000) {
  const { j } = await api("POST", "/api/run", spec);
  const runId = j.runId; if (!runId) throw new Error("no runId: " + JSON.stringify(j));
  const res = await fetch(`${B}/api/run/${runId}/stream`);
  const dec = new TextDecoder(); let buf = ""; const events = []; const started = Date.now();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true }); let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
      if (!line.startsWith("data:")) continue;
      const ev = JSON.parse(line.slice(5).trim()); events.push(ev);
      if (ev.type === "planreview") await api("POST", `/api/run/${runId}/plan`, { decision: "approve" });
      if (onEvent) await onEvent(ev, runId);
      if (ev.type === "done") return { runId, events };
    }
    if (Date.now() - started > ms) return { runId, events, timedOut: true };
  }
  return { runId, events };
}

let AGENT;
async function clearPolicies() { const { j } = await api("GET", "/api/policies"); for (const p of j.policies || []) await api("DELETE", "/api/policies/" + p.id); }
async function reset() { await clearPolicies(); if (AGENT) await api("PATCH", "/api/agents/" + AGENT, { tier: "supervised" }); }

(async () => {
  const org = (await api("GET", "/api/org")).j;
  const a = (org.agents || []).find((x) => !x.hr) || (org.agents || [])[0];
  if (!a) { console.error("no agents in org — hire one first"); process.exit(2); }
  AGENT = a.id;
  console.log(`agent under test: ${a.name} (${AGENT})`);
  await reset();

  console.log("\n=== S1: trusted tier auto-approves file_write in an attended run ===");
  await api("PATCH", "/api/agents/" + AGENT, { tier: "trusted" });
  const props1 = [];
  const r1 = await runAndStream({ agentId: AGENT, objective: "Write and save a one-paragraph welcome note for a new customer named Sam.", maxTurns: 3, autoApprove: false },
    (ev) => { if (ev.type === "propose") props1.push(ev.data); });
  const fw1 = props1.find((p) => (p.actionType || "").includes("file"));
  console.log("  events:", evCounts(r1.events));
  console.log("  proposes:", props1.map((p) => `${p.actionType}[auto=${p.autoApprove},by=${p.approver}]`).join(", ") || "(none)");
  ok(fw1, "S1: agent proposed a file_write");
  ok(fw1 && fw1.autoApprove === true, "S1: file_write auto-approved (not waiting)");
  ok(fw1 && fw1.approver === "tier:trusted", `S1: approver = tier:trusted (got "${fw1?.approver}")`);

  console.log("\n=== S2: policy 'require' overrides tier; approve via the in-app seam → DoD ===");
  await api("POST", "/api/policies", { then: "require", when: { actionType: "file_write" }, note: "e2e: all saves need me" });
  let approvedViaSeam = false;
  const r2 = await runAndStream({ agentId: AGENT, objective: "Write and save a one-sentence thank-you note for a customer named Lee.", maxTurns: 4, autoApprove: false },
    async (ev) => {
      if (ev.type === "propose" && (ev.data.actionType || "").includes("file")) {
        const p = ev.data;
        ok(p.autoApprove === false, `S2: NOT auto-approved despite trusted tier (auto=${p.autoApprove})`);
        ok(p.policy === "require", `S2: propose carries policy=require (got "${p.policy}")`);
        if (!approvedViaSeam && p.approvalId) approvedViaSeam = (await api("POST", `/api/approvals/${p.approvalId}/decide`, { decision: "approved", note: "e2e approve" })).j.ok;
      }
    });
  const verds2 = r2.events.filter((e) => e.type === "verdict").map((e) => e.data);
  console.log("  events:", evCounts(r2.events));
  console.log("  verdicts:", verds2.map((v) => `${v.verdict}[by=${v.approver}]`).join(", ") || "(none)");
  ok(approvedViaSeam, "S2: in-app seam approve returned ok");
  ok(verds2.some((v) => v.verdict === "approved" && v.approver === "you"), "S2: approved with approver='you' (via the seam)");
  ok(r2.events.some((e) => e.type === "result"), "S2: the approved write actually executed");

  console.log("\n=== S3: policy 'block' refuses file_write before any approval is filed ===");
  await reset(); await api("PATCH", "/api/agents/" + AGENT, { tier: "trusted" });
  await api("POST", "/api/policies", { then: "block", when: { actionType: "file_write" }, note: "e2e: writing disabled" });
  const r3 = await runAndStream({ agentId: AGENT, objective: "Write and save a short note titled hello.", maxTurns: 3, autoApprove: false }, null);
  const blocked3 = r3.events.filter((e) => e.type === "blocked").map((e) => e.data);
  console.log("  events:", evCounts(r3.events));
  console.log("  blocked:", blocked3.map((b) => `${b.actionType}:${b.reason}`).join(" | ") || "(none)");
  ok(blocked3.some((b) => /policy/i.test(b.reason || "")), "S3: file_write blocked by policy");
  ok(!r3.events.some((e) => e.type === "propose" && (e.data.actionType || "").includes("file")), "S3: blocked before an approval was filed");

  await reset();
  console.log(`\n===== ${fail.length ? "FAILURES ✗" : "ALL PASS ✓"} — ${pass.length} passed, ${fail.length} failed =====`);
  pass.forEach((m) => console.log("  ✓ " + m));
  fail.forEach((m) => console.log("  ✗ " + m));
  console.log("\nNote: real runs created drafts (welcome-*, thank-you-*) and may have filed/resolved approvals — tidy drafts/ if you don't want the test deliverables.");
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
