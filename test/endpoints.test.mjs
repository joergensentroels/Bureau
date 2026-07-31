// Back-fill coverage for the endpoints TESTING.md listed as an acknowledged debt: they predate the
// coverage ledger and had no tests at all. Everything here runs in a THROWAWAY workspace — several of
// these write real company config (CEO role, purchasing funds, vision, roster), so pointing them at the
// default workspace would overwrite the user's actual setup.
//   start:  BUREAU_PORT=4174 node server.mjs
//   run:    BUREAU_PORT=4174 node test/endpoints.test.mjs
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const PORT = process.env.BUREAU_PORT || 4174;
const B = `http://127.0.0.1:${PORT}`;
const TOKEN = (() => { if (process.env.OPERATOR_TOKEN) return process.env.OPERATOR_TOKEN.trim();
  try { const dir = process.env.LATCH_DATA || path.join(os.homedir(), "Documents", "LLM server", "openclaw-command-center", "data"); return JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8")).operatorToken || ""; } catch { return ""; } })();
let WS = "default";
const api = async (m, p, body) => {
  const headers = { "content-type": "application/json", "x-workspace": WS };
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  const r = await fetch(B + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { status: r.status, j };
};
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

(async () => {
  WS = (await api("POST", "/api/workspaces", { name: "Endpoint Backfill" })).j.id;
  if (!WS) { console.error("could not create a throwaway workspace"); process.exit(2); }
  try {
    // ---- company purchasing budget + purchases ------------------------------------------------
    const p0 = await api("GET", "/api/purchases");
    ok(p0.status === 200 && Array.isArray(p0.j.purchases) && p0.j.purchases.length === 0, "purchases: a new company has none");
    ok(p0.j.funds === 0 && p0.j.spent === 0, "purchases: funds and spent default to 0, not undefined");

    ok((await api("POST", "/api/company/budget", { funds: 250.5 })).j.funds === 250.5, "budget: funds set");
    ok((await api("POST", "/api/company/budget", { funds: -40 })).j.funds === 0, "budget: a negative allowance clamps to 0 rather than becoming a credit");
    ok((await api("POST", "/api/company/budget", { funds: 10.999 })).j.funds === 11, "budget: rounded to cents");
    ok((await api("POST", "/api/company/budget", { funds: "not a number" })).j.funds === 0, "budget: non-numeric → 0, not NaN");
    await api("POST", "/api/company/budget", { funds: 120 });
    ok((await api("GET", "/api/purchases")).j.funds === 120, "purchases: reports the funds the budget endpoint set");
    ok((await api("POST", "/api/company/budget", {})).j.spent === 0, "budget: response carries spent so the UI can show remaining");

    // ---- inbox --------------------------------------------------------------------------------
    const ib = await api("GET", "/api/inbox");
    ok(ib.status === 200 && Array.isArray(ib.j.approvals) && Array.isArray(ib.j.deliverables) && Array.isArray(ib.j.runs), "inbox: returns the three queues as arrays");
    ok(ib.j.counts && ib.j.counts.total === ib.j.approvals.length + ib.j.deliverables.length + ib.j.runs.length, "inbox: counts.total is the sum of the three, not a separate tally that can drift");
    ok(typeof ib.j.latchOk === "boolean", "inbox: says whether Latch answered instead of silently showing an empty approval queue");

    const seen1 = await api("POST", "/api/inbox/seen");
    ok(seen1.status === 200 && seen1.j.seenAt > 0, "inbox/seen: records a timestamp");
    ok((await api("GET", "/api/inbox")).j.seenAt === seen1.j.seenAt, "inbox: reports back the seenAt that was set");
    await new Promise((r) => setTimeout(r, 5));
    ok((await api("POST", "/api/inbox/seen")).j.seenAt >= seen1.j.seenAt, "inbox/seen: a later mark never moves backwards");

    // ---- CEO role -----------------------------------------------------------------------------
    const ceo = await api("POST", "/api/ceo", { role: "Set the strategy and approve spend." });
    ok(ceo.status === 200 && ceo.j.ceo?.role === "Set the strategy and approve spend.", "ceo: role saved");
    ok(ceo.j.ceo?.setAt > 0, "ceo: stamped with when it was set");
    ok((await api("POST", "/api/ceo", { role: "x".repeat(3000) })).j.ceo.role.length === 2000, "ceo: role is length-capped");

    // ---- agent status -------------------------------------------------------------------------
    const st = await api("GET", "/api/agent-status");
    ok(st.status === 200 && st.j.states && typeof st.j.states === "object", "agent-status: returns a states map");
    ok(Array.isArray(st.j.meeting), "agent-status: meeting is an array");

    // ---- HR endpoints: the precondition failures, which need no model -------------------------
    ok((await api("POST", "/api/hr/suggest", { brief: "need an engineer" })).j.error === "no_hr", "hr/suggest: no HR agent → no_hr (not a 500)");
    ok((await api("POST", "/api/hr/plan", { vision: "build a bakery empire" })).j.error === "no_hr", "hr/plan: no HR agent → no_hr");
    ok((await api("POST", "/api/hr/hire-plan", { roles: [] })).j.error === "no_roles", "hr/hire-plan: an empty role list → no_roles");
    ok((await api("POST", "/api/hr/hire-plan", {})).j.error === "no_roles", "hr/hire-plan: a missing role list → no_roles");

    // hire-plan builds the roster in two passes; the second resolves managerId by title, so a report
    // named before its manager exists must still end up wired to it.
    const hp = await api("POST", "/api/hr/hire-plan", { roles: [
      { title: "Head of Ops", name: "Olive" },
      { title: "Ops Analyst", name: "Andy", reportsTo: "Head of Ops" },
    ] });
    ok(hp.status === 201 && hp.j.created === 2, `hr/hire-plan: creates a roster (201, created=${hp.j.created})`);
    const roster = (await api("GET", "/api/org")).j.agents || [];
    const olive = roster.find((a) => a.name === "Olive"), andy = roster.find((a) => a.name === "Andy");
    ok(!!olive && !!andy, "hr/hire-plan: both roles were hired");
    ok(andy && olive && andy.managerId === olive.id, "hr/hire-plan: reportsTo is resolved to a real manager id (pass 2), not left dangling");
    ok(olive && olive.managerId === "", "hr/hire-plan: reportsTo \"CEO\" (the default) means no manager, not a manager named CEO");
    ok(andy && andy.persona && andy._reportsTo === undefined, "hr/hire-plan: the scratch _reportsTo field is deleted, not persisted into the org");

    // The reportsTo resolver walks up the chain to refuse a cycle. Nothing exercised it before, and a
    // cycle here is not cosmetic: delegation recurses down reporting lines, so a loop is an infinite one.
    const cyc = await api("POST", "/api/hr/hire-plan", { roles: [
      { title: "Loop A", name: "Ana", reportsTo: "Loop B" },
      { title: "Loop B", name: "Ben", reportsTo: "Loop A" },
    ] });
    ok(cyc.status === 201, "hr/hire-plan: a mutually-reporting pair is accepted");
    const r2 = (await api("GET", "/api/org")).j.agents || [];
    const ana = r2.find((a) => a.name === "Ana"), ben = r2.find((a) => a.name === "Ben");
    ok(!(ana?.managerId === ben?.id && ben?.managerId === ana?.id), "hr/hire-plan: the pair did NOT end up managing each other");

    const tri = await api("POST", "/api/hr/hire-plan", { roles: [
      { title: "Tri X", name: "Xan", reportsTo: "Tri Z" },
      { title: "Tri Y", name: "Yas", reportsTo: "Tri X" },
      { title: "Tri Z", name: "Zoe", reportsTo: "Tri Y" },
    ] });
    ok(tri.status === 201, "hr/hire-plan: a three-way cycle is accepted");
    const r3 = (await api("GET", "/api/org")).j.agents || [];
    const byId = new Map(r3.map((a) => [a.id, a]));
    let cyclesFound = 0;
    for (const a of r3) {   // walk every chain; a cycle means we revisit a node
      const seen = new Set([a.id]);
      let cur = a.managerId;
      while (cur) { if (seen.has(cur)) { cyclesFound++; break; } seen.add(cur); cur = byId.get(cur)?.managerId || ""; }
    }
    ok(cyclesFound === 0, `hr/hire-plan: no reporting cycle anywhere in the roster (delegation recurses these lines) — found ${cyclesFound}`);
    ok(r3.every((a) => !a.managerId || byId.has(a.managerId)), "hr/hire-plan: every managerId points at an agent that exists");

    const many = await api("POST", "/api/hr/hire-plan", { roles: Array.from({ length: 20 }, (_, i) => ({ title: `Bulk ${i}`, name: `Bulk${i}` })) });
    ok(many.j.created === 14, `hr/hire-plan: caps a bulk hire at 14 (got ${many.j.created})`);

    // With a roster that has no HR flag set, hr/plan still refuses rather than guessing an HR agent.
    ok((await api("POST", "/api/hr/plan", { vision: "v" })).j.error === "no_hr", "hr/plan: a roster without an HR agent still refuses");
    // And with HR present, a missing vision is its own distinct refusal.
    if (olive) await api("PATCH", "/api/agents/" + olive.id, { hr: true });
    const nv = await api("POST", "/api/hr/plan", { vision: "   " });
    ok(nv.j.error === "no_vision", `hr/plan: HR present but no vision → no_vision (got ${JSON.stringify(nv.j.error)})`);

    // ---- relocate: only the not-found path. The success path files a real Latch approval, so it is
    // deliberately left to the scripted/manual ledger rather than dropped into the automated suite.
    ok((await api("POST", "/api/agents/agent_nope/relocate", { toDepartment: "Ops" })).status === 404, "relocate: unknown agent → 404");
  } finally {
    await api("DELETE", `/api/workspaces/${WS}`);
  }
  console.log(`\n${fail.length ? "FAILURES ✗" : "ALL PASS ✓"} — ${pass.length} passed, ${fail.length} failed`);
  pass.forEach((m) => console.log("  ✓ " + m));
  fail.forEach((m) => console.log("  ✗ " + m));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
