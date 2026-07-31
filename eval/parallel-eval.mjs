// Does opt-in parallel delegation actually make a company run faster?
//
// The July 2026 attempt measured 4.6x and had to throw the number away: local qwen3's decompose is
// non-deterministic, so the sequential run and the parallel run were given different amounts of work.
// A single A/B cannot separate "concurrency helped" from "this run happened to get fewer sub-tasks".
//
// This runs the SAME objective N times in each mode, in a throwaway company, and reports per-run
// wall-clock alongside the sub-task count so the confound is visible rather than hidden. It also reports
// seconds-per-sub-task, which is the number that survives decompose variance.
//
//   node eval/parallel-eval.mjs [--runs 3] [--objective "..."] [--keep]
//
// Needs Bureau running and a local model. Uses dryRun so no real actions are taken and no approvals are
// filed; the LLM calls are real, which is what we are timing. Local model only — no paid spend.
// Creates a throwaway workspace and deletes it at the end unless --keep.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = process.env.BUREAU_PORT || 4173;
const B = `http://127.0.0.1:${PORT}`;
const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const PAID = process.argv.includes("--paid");
const RUNS = Math.max(1, Math.min(10, Number(arg("--runs", 3))));
const KEEP = process.argv.includes("--keep");
// SPENDS REAL MONEY with --paid. Two independent ceilings, both scoped to the throwaway workspace so the
// real org's guardrails and agent budgets are never touched:
//   maxPaidUsdPerRun — server-side; once reached, paid routing stops and the rest of the run goes local
//   budgetUsd        — per agent; when exhausted, that agent's calls go local
// The per-run cap is deliberately set ABOVE the expected spend: if it bound mid-run the run would be
// half-paid and its timing meaningless. It is a runaway stop, not a budget.
const CAP_PER_RUN = Number(arg("--cap", 0.25));
const AGENT_BUDGET = Number(arg("--agent-budget", 0.5));
// Retry until enough COMPARABLE pairs exist, because decompose is nondeterministic: a pair can come back
// with 1 sub-task (nothing to parallelise) or with mismatched counts (unequal work). Both bounds exist so
// "until" cannot mean "indefinitely": attempts, and — with --paid — recorded dollars.
const TARGET_PAIRS = Number(arg("--pairs", 3));
const MAX_ATTEMPTS = Number(arg("--max-attempts", 8));
const SPEND_CEILING = Number(arg("--spend-ceiling", 2.5));
const OBJECTIVE = arg("--objective",
  "Produce a short internal brief on how the company should handle customer feedback: gather input from the relevant teams, then combine it into one document.");

const TOKEN = (() => { if (process.env.OPERATOR_TOKEN) return process.env.OPERATOR_TOKEN.trim();
  try { const dir = process.env.LATCH_DATA || path.join(os.homedir(), "Documents", "LLM server", "openclaw-command-center", "data"); return JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8")).operatorToken || ""; } catch { return ""; } })();

let WS = "default";
const H = () => ({ "content-type": "application/json", "x-workspace": WS, authorization: `Bearer ${TOKEN}` });
const api = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: H(), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { status: r.status, j };
};

// Run one company run to completion over the SSE stream, timing it and counting what it actually did.
// Paid runs need a FAR longer deadline. Measured 2026-07-31: a paid sub-task takes ~300s against ~30s
// locally, so a 4-sub-task sequential run needs ~20 minutes and the original 600s deadline guillotined it
// two sub-tasks in. That is not just a lost measurement — cancelling a paid run means the `budget` event
// never fires, so the run's spend is never recorded anywhere. A harness that can spend money without
// accounting for it is worse than one that is merely slow.
const RUN_DEADLINE_MS = PAID ? 1_800_000 : 600_000;
async function timedRun(parallel, ms = RUN_DEADLINE_MS) {
  const started = Date.now();
  // hush:true forces EVERY call onto the local model — so measuring the paid tier requires hush:false.
  // (The original version of this harness always set hush:true, which meant "--paid" would have measured
  // nothing at all.)
  const { j } = await api("POST", "/api/run", { mode: "company", objective: OBJECTIVE, maxTurns: 4, dryRun: true, hush: !PAID, autoApprove: true, parallel });
  const runId = j.runId;
  if (!runId) throw new Error("no runId: " + JSON.stringify(j).slice(0, 200));
  const res = await fetch(`${B}/api/run/${runId}/stream`, { headers: { "x-workspace": WS, authorization: `Bearer ${TOKEN}` } });
  const rd = res.body.getReader(), dec = new TextDecoder();
  // `note` (a provider/run error) and `timedOut` are DIFFERENT things and must not share a flag: an
  // errored run still completes and still reports its spend, whereas a cancelled one never emits the
  // budget event at all. Conflating them made a perfectly well-accounted $0.1118 run print
  // "spend UNMEASURED".
  let buf = "", tokens = 0, note = "", usd = 0, paidTokens = 0, ranPaid = false, timedOut = false;
  const types = {};                 // full histogram, so an unexpected run shape is visible not silent
  // Assigns must be grouped into DISPATCH BATCHES, one per "plan" event. The Definition-of-Done gate can
  // re-run a whole delegation as a remediation attempt, so spread measured across the entire run mixes
  // separate batches and looks sequential even when each batch was dispatched concurrently. The
  // meaningful number is the spread WITHIN one batch.
  const batches = [];
  let cur = null;
  const openBatch = (planned) => { cur = { planned, at: [] }; batches.push(cur); };
  for (;;) {
    const { value, done } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        // emit() wraps as { type, data, at } — payload fields live under .data, NOT spread on the event.
        const d = ev.data || {};
        types[ev.type] = (types[ev.type] || 0) + 1;
        if (ev.type === "plan") openBatch(Array.isArray(d.tasks) ? d.tasks.length : 0);
        if (ev.type === "assign") { if (!cur) openBatch(0); cur.at.push(Date.now() - started); }
        if (ev.type === "budget" && typeof d.runTokens === "number") tokens = d.runTokens;
        if (ev.type === "budget") { usd = Number(d.paidSpentUsd) || 0; paidTokens = Number(d.paidTokens) || 0; ranPaid = !!d.ranPaid; }
        if (ev.type === "error" && !note) note = String(d.message || d.error || "error").slice(0, 80);
      }
    }
    if (Date.now() - started > ms) { try { await rd.cancel(); } catch {} await api("POST", `/api/run/${runId}/stop`); timedOut = true; break; }
  }
  const secs = (Date.now() - started) / 1000;
  const multi = batches.filter((b) => b.at.length > 1);          // only multi-task batches say anything
  // Concurrency signal: how many sub-tasks are dispatched in the first second of a batch.
  //
  // NOT the batch's max-minus-min spread, which was wrong twice. Spread misreads BOTH a remediation
  // re-run (two batches averaged) and — subtler — a task queued behind the semaphore: with 4 tasks and
  // ORCH_MAX_PARALLEL=3, three dispatch at once and the fourth waits ~60s for a slot, which is correct
  // behaviour that max-minus-min reports as fully sequential. Counting the opening burst is immune to
  // both, and needs no knowledge of the cap.
  const bursts = multi.map((b) => { const t0 = Math.min(...b.at); return b.at.filter((t) => t - t0 < 1000).length; });
  const subtasks = batches.reduce((n, b) => n + b.at.length, 0);
  return { secs, subtasks, planned: batches.reduce((n, b) => Math.max(n, b.planned), 0), tokens,
    batches: batches.length, multiBatches: multi.length, usd, paidTokens, ranPaid, timedOut,
    burst: bursts.length ? Math.max(...bursts) : null, bursts, types, note };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (n, d = 1) => Number(n).toFixed(d);

(async () => {
  const created = await api("POST", "/api/workspaces", { name: "Parallel Eval" });
  WS = created.j.id;
  if (!WS) { console.error("could not create a workspace — is Bureau running with the right token?"); process.exit(2); }
  console.log(`throwaway workspace: ${WS}\nobjective: ${OBJECTIVE.slice(0, 80)}…\ntarget: ${TARGET_PAIRS} usable pair(s), up to ${MAX_ATTEMPTS} attempts\n`);
  try {
    if (PAID) {
      // Refuse to start rather than quietly measure local runs and label them "paid".
      const h = (await api("GET", "/api/health")).j;
      if (!h.paid || !h.paid.model) { console.error("no paid provider configured in Latch — nothing to measure"); process.exit(2); }
      await api("POST", "/api/guardrails", { maxPaidUsdPerRun: CAP_PER_RUN });
      const back = (await api("GET", "/api/org")).j.guardrails || {};
      if (Number(back.maxPaidUsdPerRun) !== CAP_PER_RUN) { console.error(`spend cap did not stick (${JSON.stringify(back)}) — refusing to run unbounded`); process.exit(2); }
      console.log(`PAID MODE — model ${h.paid.model} via ${h.paid.provider}`);
      console.log(`  ceilings: $${CAP_PER_RUN}/run (server-side) and $${AGENT_BUDGET}/agent, workspace-scoped`);
      // State the bound that ACTUALLY binds. The per-run cap x attempts is the wrong figure: the spend
      // ceiling is checked before each pair, so the true worst case is the ceiling plus at most one
      // pair's overshoot (a pair begun just under it can still finish).
      console.log(`  stops at whichever comes first: ${TARGET_PAIRS} usable pairs · ${MAX_ATTEMPTS} attempts · $${SPEND_CEILING} recorded spend`);
      console.log(`  worst case ≈ $${(SPEND_CEILING + 2 * CAP_PER_RUN).toFixed(2)} (the ceiling is checked BETWEEN pairs, so one pair can overshoot it)\n`);
    }
    await api("POST", "/api/company", { name: "Speedco" });
    // A manager with several reports — parallelism only exists where a manager has siblings to dispatch.
    // budgetUsd > 0 is what puts an agent on the paid model at all: the manager pays for the JSON
    // orchestration calls (run.orch.payerId), and each report pays for its own turns — and it is the
    // REPORTS' slow paid turns that parallelism would overlap, so they have to be funded too or the
    // experiment measures nothing.
    const fund = PAID ? AGENT_BUDGET : 0;
    const boss = await api("POST", "/api/agents", { name: "Mara", role: "Chief of Staff", department: "Ops", persona: "delegates crisply", reportsTo: "", budgetUsd: fund });
    if (!boss.j.id) { console.error("could not hire the manager: " + JSON.stringify(boss.j).slice(0, 200)); process.exit(2); }
    for (const [name, role, dept] of [["Rio", "Support Lead", "Support"], ["Ida", "Product Analyst", "Product"], ["Sol", "Engineer", "Engineering"]])
      await api("POST", "/api/agents", { name, role, department: dept, persona: "concise and practical", reportsTo: boss.j.id, budgetUsd: fund });
    console.log(`hired: Mara + 3 reports${PAID ? ` (each funded $${fund})` : ""}\n`);

    const results = { sequential: [], parallel: [] };
    const pairs = [];
    let spent = 0;
    // Usability is a property of the PAIR, not of a run. A sequential run is only a valid control for the
    // parallel run it is compared against, so both halves have to be sound AND comparable.
    //
    // The <2 sub-task rule is the one that only became obvious from real data: decompose sometimes emits a
    // single task, and a run with one sub-task cannot exhibit concurrency at all — it is not a slow
    // parallel run, it is a run with nothing to parallelise. Pooling those drags any speedup toward 1.0x
    // and looks like evidence against parallelism when it is really an absence of evidence.
    const rejectReason = (s, p) => {
      if (!s || !p) return "a run failed to start";
      if (s.timedOut || p.timedOut) return "a run was cancelled, so its spend and timing are unaccounted";
      if (s.note || p.note) return `provider error (${(s.note || p.note).slice(0, 60)}) — a failed paid call can fall back to the ~10x faster local model`;
      if (s.subtasks < 2 || p.subtasks < 2) return `nothing to parallelise (${s.subtasks} vs ${p.subtasks} sub-tasks; need >= 2)`;
      if (s.subtasks !== p.subtasks) return `unequal work (${s.subtasks} vs ${p.subtasks} sub-tasks) — decompose variance, the confound that invalidated the July measurement`;
      // A run that exhausted the per-run spend cap finished its tail on the LOCAL model, which is ~10x
      // faster — so its wall-clock is a paid/local mixture, not a paid measurement. This condition was
      // already detected and warned about per-run, but not enforced here, so a contaminated pair was
      // still counted as usable. Detecting a contaminant and then pooling it anyway is the same mistake
      // as printing a warning nobody acts on.
      if (PAID && (s.usd >= CAP_PER_RUN || p.usd >= CAP_PER_RUN))
        return `a run hit the $${CAP_PER_RUN} per-run cap ($${Math.max(s.usd, p.usd).toFixed(4)}), so its tail ran on the local model and the timing is a paid/local mixture`;
      return "";
    };
    // Keep going until enough USABLE pairs exist, bounded by attempts and by spend so "until" can never
    // mean "indefinitely" with someone's money.
    while (pairs.filter((x) => x.usable).length < TARGET_PAIRS && pairs.length < MAX_ATTEMPTS) {
      if (PAID && spent >= SPEND_CEILING) { console.log(`\nSTOPPING EARLY: spend ceiling $${SPEND_CEILING} reached ($${spent.toFixed(4)} recorded).`); break; }
      const attempt = pairs.length + 1;
      const got = {};
      for (const mode of ["sequential", "parallel"]) {   // alternate so load drift hits both arms
        process.stdout.write(`  pair ${attempt} ${mode.padEnd(10)} … `);
        try {
          const r = await timedRun(mode === "parallel");
          got[mode] = r;
          results[mode].push(r);
          spent += r.usd || 0;
          console.log(`${fmt(r.secs)}s  assigned=${r.subtasks} planned=${r.planned} batches=${r.batches}` +
            `  dispatched-at-once=${r.burst == null ? "n/a" : r.burst}  tokens=${r.tokens}` +
            // Only a CANCELLED run has no accounting: spend lands in the `budget` event, which a stopped
            // run never emits. An errored-but-completed run reports its spend perfectly well.
            (PAID ? (r.timedOut ? "  PAID=? (cancelled before accounting — spend UNMEASURED)"
                                : `  PAID=${r.ranPaid ? "yes" : "NO"} $${r.usd.toFixed(4)} (${r.paidTokens} tok)`) : "") +
            `${r.note ? "  note=" + r.note : ""}`);
          if (PAID && !r.timedOut && !r.ranPaid) console.log("      ⚠ this run completed WITHOUT using the paid model — funding or provider problem, not a paid measurement");
          // A provider error mid-run is a CONFOUND, not a footnote: a failed paid call may fall back to
          // the local model, which finishes ~10x faster and would flatter whichever mode hit the error.
          if (PAID && r.note) console.log(`      ⚠ provider error during this run ("${r.note}") — a paid call may have degraded or fallen back to local, so this timing is NOT a clean paid measurement`);
          if (PAID && r.usd >= CAP_PER_RUN) console.log(`      ⚠ hit the $${CAP_PER_RUN} per-run cap — the tail of this run fell back to local, so its timing is mixed`);
          if (r.subtasks === 0) console.log(`      events: ${Object.entries(r.types).map(([k, v]) => `${k}:${v}`).join(" ")}`);
        } catch (e) { console.log("FAILED: " + e.message); }
      }
      const why = rejectReason(got.sequential, got.parallel);
      pairs.push({ s: got.sequential, p: got.parallel, usable: !why, why });
      const nUsable = pairs.filter((x) => x.usable).length;
      console.log(why ? `    ✗ pair ${attempt} REJECTED — ${why}` : `    ✓ pair ${attempt} usable (${got.sequential.subtasks} sub-tasks each)`);
      console.log(`    progress: ${nUsable}/${TARGET_PAIRS} usable · ${pairs.length}/${MAX_ATTEMPTS} attempts` + (PAID ? ` · $${spent.toFixed(4)} spent of $${SPEND_CEILING} ceiling` : ""));
    }

    // ---- the answer, computed ONLY from usable pairs ----
    const usable = pairs.filter((x) => x.usable);
    console.log(`\n════════ USABLE PAIRS: ${usable.length}/${TARGET_PAIRS} (from ${pairs.length} attempts) ════════`);
    if (usable.length) {
      for (const [i, u] of usable.entries())
        console.log(`  pair ${i + 1}: ${fmt(u.s.secs)}s sequential vs ${fmt(u.p.secs)}s parallel  (${u.s.subtasks} sub-tasks, ${fmt(u.s.secs / u.p.secs, 2)}x)`);
      // For MATCHED pairs the right statistic is the median of the per-pair ratios, not the ratio of the
      // two medians: those medians can come from different pairs, which throws away the pairing that the
      // whole design exists to preserve. (With n=3 the ratio-of-medians degenerated into simply echoing
      // one pair's ratio.) Both are printed, ratio-of-ratios first.
      const ratios = usable.map((u) => u.s.secs / u.p.secs);
      const mSeq = median(usable.map((u) => u.s.secs)), mPar = median(usable.map((u) => u.p.secs));
      console.log(`\n  >>> SPEEDUP: ${fmt(median(ratios), 2)}x  — median of per-pair ratios (n=${usable.length}), range ${fmt(Math.min(...ratios), 2)}–${fmt(Math.max(...ratios), 2)}x`);
      console.log(`      (ratio of medians, for reference: ${fmt(mSeq / mPar, 2)}x — sequential ${fmt(mSeq)}s vs parallel ${fmt(mPar)}s)`);
      // Cost is the other half of the tradeoff and moves independently of speed.
      const costs = usable.map((u) => (u.p.usd || 0) / (u.s.usd || 1));
      if (PAID) console.log(`      cost of parallel vs sequential: ${usable.map((u, i) => `pair${i + 1} ${fmt(100 * costs[i] - 100, 0)}%`).join(", ")} (median ${fmt(100 * median(costs) - 100, 0)}%)`);
      if (usable.length < TARGET_PAIRS) console.log(`  ⚠ fewer than the ${TARGET_PAIRS} pairs asked for — treat this as provisional.`);
    } else {
      console.log("  ⚠ NO usable pairs. Quote nothing from the per-mode aggregates below; they pool runs that are not comparable.");
    }
    if (pairs.some((x) => !x.usable)) {
      console.log("\n  rejected pairs and why:");
      pairs.filter((x) => !x.usable).forEach((x, i) => console.log(`    - ${x.why}`));
    }

    console.log("\n──────── all runs pooled (for reference only — includes non-comparable runs) ────────");
    for (const mode of ["sequential", "parallel"]) {
      const rs = results[mode];
      if (!rs.length) { console.log(`${mode}: no successful runs`); continue; }
      const secs = rs.map((r) => r.secs), subs = rs.map((r) => r.subtasks);
      const perTask = rs.filter((r) => r.subtasks > 0).map((r) => r.secs / r.subtasks);
      console.log(`${mode.padEnd(11)} median ${fmt(median(secs))}s  (range ${fmt(Math.min(...secs))}–${fmt(Math.max(...secs))})  subtasks median ${median(subs)}  sec/subtask median ${perTask.length ? fmt(median(perTask)) : "n/a"}`);
    }
    // A run that logged a provider error may have fallen back to the ~10x faster local model, so it
    // cannot be pooled with clean runs. Discarding those is part of the protocol, not a judgement call
    // made afterwards — so the harness does it here rather than leaving it to whoever reads the output.
    const clean = (rs) => rs.filter((r) => !r.note && !r.timedOut);
    const cs = clean(results.sequential), cp = clean(results.parallel);
    if (PAID) {
      // Kept only as a cross-check on the pooled data. This block predates the pair logic and used to be
      // labelled "the number to quote" — which was wrong once pairing existed: it pools runs from
      // DIFFERENT pairs, so unequal sub-task counts and cap-hit runs leak straight back in. On this run it
      // read 1.98x against the matched-pair answer of 1.73x, purely from that pooling. The matched-pair
      // block above is authoritative; if the two disagree, believe the pairs.
      console.log(`\n──────── pooled cross-check (NOT the answer — mixes runs across pairs) ────────`);
      console.log(`  sequential: ${cs.length}/${results.sequential.length} error-free · parallel: ${cp.length}/${results.parallel.length}`);
      if (cs.length && cp.length) {
        const cSeq = median(cs.map((r) => r.secs)), cPar = median(cp.map((r) => r.secs));
        console.log(`  ratio of pooled medians: ${fmt(cSeq / cPar, 2)}x  (${fmt(cSeq)}s vs ${fmt(cPar)}s) — expect this to overstate; quote the matched-pair figure`);
      }
    }
    const sq = results.sequential, pl = results.parallel;
    if (sq.length && pl.length) {
      const rawSpeedup = median(sq.map((r) => r.secs)) / median(pl.map((r) => r.secs));
      const seqPer = sq.filter((r) => r.subtasks > 0).map((r) => r.secs / r.subtasks);
      const plPer = pl.filter((r) => r.subtasks > 0).map((r) => r.secs / r.subtasks);
      console.log(`\nraw wall-clock speedup (median/median): ${fmt(rawSpeedup, 2)}x`);
      if (seqPer.length && plPer.length)
        console.log(`per-subtask speedup (controls for decompose variance): ${fmt(median(seqPer) / median(plPer), 2)}x`);
      const subDiff = Math.abs(median(sq.map((r) => r.subtasks)) - median(pl.map((r) => r.subtasks)));
      if (subDiff > 0.5) console.log(`\n⚠  the two modes got DIFFERENT amounts of work (median sub-task counts differ by ${subDiff}) — trust the per-subtask number, not the raw one.`);
      const sqB = sq.map((r) => r.burst).filter((x) => x != null);
      const plB = pl.map((r) => r.burst).filter((x) => x != null);
      console.log(`\nconcurrency check — median sub-tasks dispatched within 1s: sequential ${sqB.length ? median(sqB) : "n/a"} vs parallel ${plB.length ? median(plB) : "n/a"}`);
      console.log("(sequential dispatches one at a time, so 1; parallel dispatches up to ORCH_MAX_PARALLEL at once)");
      if (plB.length && median(plB) <= 1) console.log("⚠  parallel dispatched only one sub-task at a time — the concurrency is NOT taking effect.");
    }
    if (PAID) {
      const all = [...results.sequential, ...results.parallel];
      const spent = all.reduce((s, r) => s + (r.usd || 0), 0);
      const paidRuns = all.filter((r) => r.ranPaid).length;
      const unmeasured = all.filter((r) => r.timedOut).length;
      const errored = all.filter((r) => r.note).length;
      console.log(`\nRECORDED SPEND: $${spent.toFixed(4)} across ${paidRuns} completed paid run(s) of ${all.length}`);
      if (unmeasured) console.log(`⚠ ${unmeasured} run(s) were cancelled, so their spend is UNMEASURED — real cost is higher than the figure above.`);
      if (errored) console.log(`⚠ ${errored} run(s) hit a provider error — the speedup above is CONTAMINATED, because a failed paid call can fall back to the ~10x faster local model.`);
      if (paidRuns === 0) console.log("⚠ no run completed on the paid model — treat every number above as unusable.");
    } else {
      console.log("\nCaveat: local qwen3 is served by ONE ollama instance, so concurrent siblings largely");
      console.log("re-serialise at the model — measured 0.92x. Re-run with --paid to test the case parallel");
      console.log("was actually built for: overlapping slow external calls that do NOT share one process.");
    }
  } finally {
    if (!KEEP && WS !== "default") { await api("DELETE", "/api/workspaces/" + WS); console.log("\ncleaned up throwaway workspace"); }
    else console.log(`\nkept workspace ${WS}`);
  }
})();
