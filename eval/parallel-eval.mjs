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
const RUNS = Math.max(1, Math.min(10, Number(arg("--runs", 3))));
const KEEP = process.argv.includes("--keep");
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
async function timedRun(parallel, ms = 600000) {
  const started = Date.now();
  const { j } = await api("POST", "/api/run", { mode: "company", objective: OBJECTIVE, maxTurns: 4, dryRun: true, hush: true, autoApprove: true, parallel });
  const runId = j.runId;
  if (!runId) throw new Error("no runId: " + JSON.stringify(j).slice(0, 200));
  const res = await fetch(`${B}/api/run/${runId}/stream`, { headers: { "x-workspace": WS, authorization: `Bearer ${TOKEN}` } });
  const rd = res.body.getReader(), dec = new TextDecoder();
  let buf = "", tokens = 0, note = "";
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
        if (ev.type === "error" && !note) note = String(d.message || d.error || "error").slice(0, 80);
      }
    }
    if (Date.now() - started > ms) { try { await rd.cancel(); } catch {} await api("POST", `/api/run/${runId}/stop`); note = note || "timed out"; break; }
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
    batches: batches.length, multiBatches: multi.length,
    burst: bursts.length ? Math.max(...bursts) : null, bursts, types, note };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (n, d = 1) => Number(n).toFixed(d);

(async () => {
  const created = await api("POST", "/api/workspaces", { name: "Parallel Eval" });
  WS = created.j.id;
  if (!WS) { console.error("could not create a workspace — is Bureau running with the right token?"); process.exit(2); }
  console.log(`throwaway workspace: ${WS}\nobjective: ${OBJECTIVE.slice(0, 80)}…\nruns per mode: ${RUNS}\n`);
  try {
    await api("POST", "/api/company", { name: "Speedco" });
    // A manager with several reports — parallelism only exists where a manager has siblings to dispatch.
    const boss = await api("POST", "/api/agents", { name: "Mara", role: "Chief of Staff", department: "Ops", persona: "delegates crisply", reportsTo: "" });
    if (!boss.j.id) { console.error("could not hire the manager: " + JSON.stringify(boss.j).slice(0, 200)); process.exit(2); }
    for (const [name, role, dept] of [["Rio", "Support Lead", "Support"], ["Ida", "Product Analyst", "Product"], ["Sol", "Engineer", "Engineering"]])
      await api("POST", "/api/agents", { name, role, department: dept, persona: "concise and practical", reportsTo: boss.j.id });
    console.log("hired: Mara + 3 reports\n");

    const results = { sequential: [], parallel: [] };
    // Alternate modes so any drift in machine load is shared between them rather than biasing one.
    for (let i = 0; i < RUNS; i++) {
      for (const mode of ["sequential", "parallel"]) {
        process.stdout.write(`  run ${i + 1} ${mode.padEnd(10)} … `);
        try {
          const r = await timedRun(mode === "parallel");
          results[mode].push(r);
          console.log(`${fmt(r.secs)}s  assigned=${r.subtasks} planned=${r.planned} batches=${r.batches}` +
            `  dispatched-at-once=${r.burst == null ? "n/a" : r.burst}  tokens=${r.tokens}${r.note ? "  note=" + r.note : ""}`);
          if (r.subtasks === 0) console.log(`      events: ${Object.entries(r.types).map(([k, v]) => `${k}:${v}`).join(" ")}`);
        } catch (e) { console.log("FAILED: " + e.message); }
      }
    }

    console.log("\n──────── results ────────");
    for (const mode of ["sequential", "parallel"]) {
      const rs = results[mode];
      if (!rs.length) { console.log(`${mode}: no successful runs`); continue; }
      const secs = rs.map((r) => r.secs), subs = rs.map((r) => r.subtasks);
      const perTask = rs.filter((r) => r.subtasks > 0).map((r) => r.secs / r.subtasks);
      console.log(`${mode.padEnd(11)} median ${fmt(median(secs))}s  (range ${fmt(Math.min(...secs))}–${fmt(Math.max(...secs))})  subtasks median ${median(subs)}  sec/subtask median ${perTask.length ? fmt(median(perTask)) : "n/a"}`);
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
    console.log("\nCaveat: local qwen3 is served by ONE ollama instance, so concurrent siblings largely");
    console.log("re-serialise at the model. The real win parallel targets is overlapping slow PAID calls.");
  } finally {
    if (!KEEP && WS !== "default") { await api("DELETE", "/api/workspaces/" + WS); console.log("\ncleaned up throwaway workspace"); }
    else console.log(`\nkept workspace ${WS}`);
  }
})();
