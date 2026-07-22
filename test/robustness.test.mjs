// Robustness / hardening tests: malformed input, oversized payloads, unicode, unknown routes, and
// the concurrent-write (mutex) guarantee. Needs a running server; no model. All state lives in
// throwaway workspaces created and deleted here — the real (default) company is never touched.
//   start:  BUREAU_PORT=4174 node server.mjs
//   run:    BUREAU_PORT=4174 node test/robustness.test.mjs
const PORT = process.env.BUREAU_PORT || 4174;
const B = `http://127.0.0.1:${PORT}`;
let WS = "default";
// JSON helper (adds workspace header)
const api = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json", "x-workspace": WS }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { status: r.status, j };
};
// raw helper (send an arbitrary string body — for malformed / oversized cases)
const raw = async (m, p, bodyStr) => {
  const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json", "x-workspace": WS }, body: bodyStr });
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { status: r.status, j };
};
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

(async () => {
  const main = await api("POST", "/api/workspaces", { name: "Robustness" });
  WS = main.j.id;
  if (!WS) { console.error("could not create test workspace"); process.exit(2); }

  try {
    // ---- unknown route / wrong method ----
    ok((await api("GET", "/api/does-not-exist")).status === 404, "unknown route → 404");
    ok((await api("DELETE", "/api/health")).status === 404, "wrong method on a real route → 404");

    // ---- malformed JSON body → graceful (readBody returns {}, endpoint validation kicks in) ----
    ok((await raw("POST", "/api/goals", "{ this is : not json ")).status === 400, "malformed JSON body → 400 (missing required field), not 500");
    { const r = await raw("POST", "/api/company", "not json at all"); ok(r.status === 200 && r.j.companyName === "", "malformed body on optional-field endpoint → treated as empty, not a crash"); }

    // ---- oversized FIELD is truncated, not rejected ----
    { const r = await api("POST", "/api/company", { name: "x".repeat(5000) }); ok(r.status === 200 && r.j.companyName.length === 60, "oversized company name truncated to 60"); }
    { const r = await api("POST", "/api/goals", { title: "y".repeat(5000) }); ok(r.status === 201 && r.j.title.length === 160, "oversized goal title truncated to 160"); await api("DELETE", "/api/goals/" + r.j.id); }

    // ---- oversized BODY → 413 (the new cap) ----
    { const big = "x".repeat(5 * 1024 * 1024); const r = await raw("POST", "/api/company", big); ok(r.status === 413, "oversized request body (>4MB) → 413"); }

    // ---- unicode / control chars don't break storage ----
    { const r = await api("POST", "/api/agents", { name: "🤖 Ünïçødé\n\t " + "z".repeat(100), role: "Analyst" });
      ok(r.status === 201 && r.j.id && r.j.name.length <= 60, "unicode/long agent name accepted + length-capped");
      await api("DELETE", "/api/agents/" + r.j.id); }

    // ---- unicode workspace name still yields a filename-safe id ----
    { const r = await api("POST", "/api/workspaces", { name: "日本語 Team 🌸" });
      ok(r.status === 201 && /^[a-z0-9][a-z0-9-]{0,30}$/.test(r.j.id), "non-ASCII workspace name → filename-safe id");
      if (r.j.id) await api("DELETE", "/api/workspaces/" + r.j.id); }

    // ---- missing required fields → 400 ----
    ok((await api("POST", "/api/schedules", {})).status === 400, "schedule without objective → 400");
    ok((await api("POST", "/api/triggers", {})).status === 400, "trigger without objective → 400");

    // ---- concurrent same-workspace writes must not clobber (per-workspace mutex) ----
    { const cws = (await api("POST", "/api/workspaces", { name: "Concurrency" })).j.id;
      const save = WS; WS = cws;
      const N = 15;
      await Promise.all(Array.from({ length: N }, (_, i) => api("POST", "/api/agents", { name: "Agent" + i, role: "R" })));
      const count = (await api("GET", "/api/org")).j.agents.length;
      ok(count === N, `all ${N} concurrent agent writes landed (got ${count}) — no lost updates`);
      WS = save; await api("DELETE", "/api/workspaces/" + cws); }
  } finally {
    WS = "default";
    await api("DELETE", "/api/workspaces/" + main.j.id);
  }

  console.log(`${fail.length ? "FAILURES ✗" : "ALL PASS ✓"} — ${pass.length} passed, ${fail.length} failed`);
  pass.forEach((m) => console.log("  ✓ " + m));
  fail.forEach((m) => console.log("  ✗ " + m));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
