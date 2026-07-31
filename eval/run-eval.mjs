#!/usr/bin/env node
// Bureau — offline eval / regression harness for the JSON-critical orchestration calls.
//
// Measures how reliably the three calls the weak local model is worst at — deriveCriteria,
// verifyRun, and delegate's decompose — produce PARSEABLE, SCHEMA-VALID output, and (with --paid)
// how much the cheap paid Kimi tier improves that over local qwen3. This turns "qwen3 is flaky at
// JSON" from a war story into a number you can watch and regression-gate.
//
// It has NO side effects on a running Bureau: it imports the REAL prompt builders + safeParse +
// validators + askLlm from server.mjs (which is import-safe — its bootstrap is guarded behind isMain)
// and talks to Latch directly. It never starts the server, opens the DB, writes drafts, or files
// approvals. So what's measured is the exact production prompt + production parser.
//
// Usage:
//   node eval/run-eval.mjs                  # local only (free), all call-types, 5 reps
//   node eval/run-eval.mjs --paid           # ALSO run the cheap paid Kimi tier (spends real cents)
//   node eval/run-eval.mjs --reps=8         # repetitions per case (flakiness is a rate, not a bool)
//   node eval/run-eval.mjs --type=decompose # just one call-type (criteria|verify|decompose)
//   node eval/run-eval.mjs --save-baseline  # write the LOCAL aggregates to eval/baseline.json
//   node eval/run-eval.mjs --baseline       # compare LOCAL run to the baseline; exit 1 on regression
//
// On reps and the gate: these are RATES over n = reps × cases (5 reps × 4 criteria cases = n 20), so one
// sample is worth 1/n. --baseline floors its tolerance at 1/n and prints the arithmetic. It also compares
// p50 latency, because single-shot rate is confounded by machine load: identical code and cases scored
// 78%/80% while other work competed for Ollama and 100% with the machine idle, `effective` and
// `schema-valid` at 100% throughout. **Run the gate on an otherwise idle machine, or its verdict is about
// your CPU.** Baselines written before 2026-07-31 carry no `n`/`p50ms`; the gate says so rather than
// assuming.
//
// No dependencies. Node built-ins only.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initLatchAuth, askLlm, safeParse, paidProviderAvailable,
  buildCriteriaMsgs, buildVerifyMsgs, buildDecomposeMsgs,
  validateCriteria, validateVerify, validateDecompose,
} from "../server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(HERE, "reports");
const BASELINE_FILE = path.join(HERE, "baseline.json");

// The escalation ladders below MIRROR the production askJsonReliable budgets for each call. The gate
// runs at temperature 0 (GATE_TEMPERATURE); the paid tier is kimi-k2.6 at $0.002/1K (ORCH_TIER).
const LADDERS = { criteria: [1200, 3200], verify: [1500, 3600], decompose: [900, 3200] };
const ORCH_MODEL = "kimi-k2.6";
const ORCH_PRICE_PER_1K = 0.002;
const estTokens = (msgs) => Math.ceil(msgs.reduce((n, m) => n + String(m.content || "").length, 0) / 4);

// ---- args ----
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => { const m = argv.find((a) => a.startsWith(`--${name}=`)); return m ? m.split("=")[1] : dflt; };
const REPS = Math.max(1, Number(opt("reps", 5)) || 5);
const ONLY_TYPE = opt("type", "");
const WANT_PAID = flag("paid");
const SAVE_BASELINE = flag("save-baseline");
const CHECK_BASELINE = flag("baseline");
const TOL = Number(opt("tol", 0.15)) || 0.15;   // regression tolerance (absolute rate drop) for --baseline
// --dependson: ask decompose for an extra `dependsOn` field per task. This is the GATE on parallel
// Stage 2 (dependency-aware decompose): decompose is already the flakiest JSON call at 50% single-shot,
// so before building anything on `dependsOn` we need to know whether merely asking for it makes that
// worse. Run the same command with and without the flag and compare.
const WANT_DEPENDSON = flag("dependson");

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const quantile = (xs, q) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const i = Math.min(s.length - 1, Math.floor(q * s.length)); return s[i]; };

// Run one case once through the escalation ladder, controlling routing. Stops at the first parse
// success, exactly like production askJsonReliable. Returns per-run telemetry.
async function runLadder(msgs, budgets, mode) {
  const t0 = performance.now();
  let rungs = 0, obj = null, raw = "", tokens = 0, paid = false, usd = 0;
  for (const maxTokens of budgets) {
    rungs++;
    const meta = {};
    let text = "";
    try {
      text = await askLlm(msgs, { maxTokens, temperature: 0, meta, ...(mode === "paid" ? { routingPreference: "external", model: ORCH_MODEL } : {}) });
    } catch { break; }   // provider/network error — matches production (break the ladder)
    tokens += estTokens(msgs) + Math.ceil(text.length / 4);
    if (meta.paid) { paid = true; const t = meta.usage?.total_tokens || (estTokens(msgs) + Math.ceil(text.length / 4)); usd += (t / 1000) * ORCH_PRICE_PER_1K; }
    if (text) raw = text;
    const parsed = safeParse(text);
    if (parsed) { obj = parsed; break; }
  }
  const ms = performance.now() - t0;
  return { rungs, obj, raw, tokens, paid, usd, ms, singleShotParseOk: obj != null && rungs === 1, effectiveParseOk: obj != null };
}

// Score one parsed object against the matching production validator; returns {schemaOk, extra}.
function score(type, obj, kase) {
  if (type === "criteria") { const v = validateCriteria(obj); return { schemaOk: v.ok, count: v.count }; }
  if (type === "decompose") {
    const v = validateDecompose(obj, kase.reports);
    const dep = WANT_DEPENDSON ? scoreDependsOn(obj) : null;
    return { schemaOk: v.ok, count: v.count, fannedOut: v.fannedOut, ...(dep ? { depPresent: dep.present, depWellFormed: dep.wellFormed } : {}) };
  }
  if (type === "verify") {
    const v = validateVerify(obj, kase.criteria.length);
    let correct = 0;
    if (v.ok) for (let i = 0; i < kase.criteria.length; i++) if (v.verdicts[i] === !!kase.criteria[i].expectedMet) correct++;
    return { schemaOk: v.ok, count: v.count, verdictCorrect: v.ok ? correct : null, verdictTotal: kase.criteria.length };
  }
  return { schemaOk: false };
}

// The exact schema line inside the production decompose system prompt. Patched rather than rewritten so
// the variant differs from production by ONE field and nothing else — otherwise the A/B measures a
// different prompt instead of the cost of the extra field.
const DECOMPOSE_SCHEMA_LINE = '{ "plan":"one sentence on your approach", "tasks":[{"assignee":"<exact report name>","task":"<what to do>"}] }';
const DEPENDSON_SCHEMA_LINE = '{ "plan":"one sentence on your approach", "tasks":[{"assignee":"<exact report name>","task":"<what to do>","dependsOn":[<0-based indexes of earlier tasks whose output this one needs; [] if independent>]}] }';
function withDependsOn(msgs) {
  const sys = msgs[0];
  if (!String(sys?.content || "").includes(DECOMPOSE_SCHEMA_LINE))
    // Fail loudly. A silent no-op here would run the BASELINE prompt twice and report "no regression",
    // which is exactly the shape of bug that let `hush:true` make an earlier --paid run measure nothing.
    throw new Error("--dependson: the decompose schema line no longer matches; update DECOMPOSE_SCHEMA_LINE in run-eval.mjs");
  const patched = String(sys.content)
    .replace(DECOMPOSE_SCHEMA_LINE, DEPENDSON_SCHEMA_LINE)
    + '\nEvery task MUST carry "dependsOn": an array of 0-based indexes of earlier tasks in this same list whose finished output it needs. Use [] for a task that can start immediately.';
  return [{ ...sys, content: patched }, ...msgs.slice(1)];
}
// How well the model actually FILLED the field — separate from whether the JSON parsed. A variant that
// parses fine but emits garbage dependencies is no use for building topological levels on.
function scoreDependsOn(obj) {
  const tasks = Array.isArray(obj?.tasks) ? obj.tasks : [];
  if (!tasks.length) return null;
  let present = 0, wellFormed = 0;
  tasks.forEach((t, i) => {
    if (!("dependsOn" in (t || {}))) return;
    present++;
    const d = t.dependsOn;
    // Well-formed = an array of integers that all point at EARLIER tasks (a forward or self reference
    // cannot be executed in order, so it is not usable even though it parses).
    if (Array.isArray(d) && d.every((x) => Number.isInteger(x) && x >= 0 && x < i)) wellFormed++;
  });
  return { present: present / tasks.length, wellFormed: wellFormed / tasks.length };
}

function buildMsgs(type, kase) {
  if (type === "criteria") return buildCriteriaMsgs(kase.objective);
  if (type === "decompose") {
    const base = buildDecomposeMsgs("Manager", kase.reports, kase.objective);
    return WANT_DEPENDSON ? withDependsOn(base) : base;
  }
  if (type === "verify") return buildVerifyMsgs(kase.objective, kase.criteria.map((c) => ({ text: c.text })), kase.evidence);
  throw new Error(`unknown type ${type}`);
}

async function evalTypeMode(type, cases, mode) {
  const rows = [];
  for (const kase of cases) {
    const msgs = buildMsgs(type, kase);
    for (let rep = 0; rep < REPS; rep++) {
      const r = await runLadder(msgs, LADDERS[type], mode);
      const s = r.obj ? score(type, r.obj, kase) : { schemaOk: false, verdictCorrect: null, verdictTotal: type === "verify" ? kase.criteria.length : 0, fannedOut: false };
      rows.push({ ...r, ...s });
      process.stdout.write(r.effectiveParseOk ? (s.schemaOk ? "." : "x") : "!");
    }
  }
  process.stdout.write(` ${type}/${mode}\n`);

  const schemaRows = rows.filter((r) => r.schemaOk);
  const vc = rows.filter((r) => r.verdictCorrect != null);
  return {
    n: rows.length,
    singleShotRate: mean(rows.map((r) => r.singleShotParseOk ? 1 : 0)),
    effectiveRate: mean(rows.map((r) => r.effectiveParseOk ? 1 : 0)),
    schemaRate: mean(rows.map((r) => r.schemaOk ? 1 : 0)),
    fanOutRate: type === "decompose" ? mean(schemaRows.map((r) => r.fannedOut ? 1 : 0)) : null,
    // Aggregated, not just computed: score() produced these per row and nothing carried them into the
    // report, so the fill quality of `dependsOn` was silently discarded and had to be probed by hand.
    // "Parses" and "is usable" are different questions and both belong in the output.
    depPresentRate: WANT_DEPENDSON && schemaRows.length ? mean(schemaRows.map((r) => r.depPresent || 0)) : null,
    depWellFormedRate: WANT_DEPENDSON && schemaRows.length ? mean(schemaRows.map((r) => r.depWellFormed || 0)) : null,
    verdictAccuracy: type === "verify" && vc.length ? mean(vc.map((r) => r.verdictCorrect / r.verdictTotal)) : null,
    verdictSample: type === "verify" ? vc.length : null,
    p50ms: Math.round(quantile(rows.map((r) => r.ms), 0.5)),
    p95ms: Math.round(quantile(rows.map((r) => r.ms), 0.95)),
    meanTokens: Math.round(mean(rows.map((r) => r.tokens))),
    usd: Math.round(rows.reduce((a, r) => a + r.usd, 0) * 1e6) / 1e6,
  };
}

function renderTable(results) {
  const lines = [];
  const hdr = "| call-type | mode | single-shot | effective | schema-valid | extra | p50 | p95 | tok | $ |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|";
  lines.push(hdr, sep);
  for (const { type, mode, agg } of results) {
    const extra = type === "decompose" ? `fan-out ${agg.fanOutRate == null ? "—" : pct(agg.fanOutRate)}`
      + (agg.depWellFormedRate == null ? "" : ` · dependsOn present ${pct(agg.depPresentRate)} / usable ${pct(agg.depWellFormedRate)}`)
      : type === "verify" ? `verdict ${agg.verdictAccuracy == null ? "—" : pct(agg.verdictAccuracy)} (n=${agg.verdictSample})`
        : "—";
    lines.push(`| ${type} | ${mode} | ${pct(agg.singleShotRate)} | ${pct(agg.effectiveRate)} | ${pct(agg.schemaRate)} | ${extra} | ${agg.p50ms}ms | ${agg.p95ms}ms | ${agg.meanTokens} | ${agg.usd ? "$" + agg.usd.toFixed(4) : "—"} |`);
  }
  return lines.join("\n");
}

async function main() {
  await initLatchAuth();

  const raw = JSON.parse(await readFile(path.join(HERE, "cases.json"), "utf8"));
  const allTypes = ["criteria", "decompose", "verify"];
  const types = ONLY_TYPE ? allTypes.filter((t) => t === ONLY_TYPE) : allTypes;
  if (!types.length) { console.error(`Unknown --type=${ONLY_TYPE} (expected criteria|decompose|verify)`); process.exit(2); }

  const modes = ["local"];
  if (WANT_PAID) {
    if (await paidProviderAvailable()) {
      modes.push("paid");
      const paidCases = types.reduce((n, t) => n + raw[t].length, 0);
      console.log(`⚠ --paid: ~${paidCases * REPS} paid Kimi calls queued (est. a few cents). Kimi is slow (up to ~120s/call).`);
    } else {
      console.log("⚠ --paid requested but no paid provider is available via Latch — running LOCAL only.");
    }
  }

  console.log(`\nBureau orchestration eval — ${REPS} reps/case, types: ${types.join(", ")}, modes: ${modes.join(", ")}\n`);
  const results = [];
  for (const type of types) {
    for (const mode of modes) {
      const agg = await evalTypeMode(type, raw[type], mode);
      results.push({ type, mode, agg });
    }
  }

  const table = renderTable(results);
  console.log("\n" + table + "\n");
  console.log("Legend: single-shot = parsed on first token budget · effective = parsed anywhere in the ladder · schema-valid = parsed AND passed the production validator.");

  // Persist a timestamped report (raw + rendered) — reports/ is gitignored.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(REPORTS_DIR, { recursive: true });
  const report = { at: new Date().toISOString(), reps: REPS, types, modes, results };
  await writeFile(path.join(REPORTS_DIR, `${stamp}.json`), JSON.stringify(report, null, 2));
  await writeFile(path.join(REPORTS_DIR, `${stamp}.md`), `# Bureau orchestration eval — ${report.at}\n\n${REPS} reps/case · modes: ${modes.join(", ")}\n\n${table}\n`);
  console.log(`\nReport: eval/reports/${stamp}.{json,md}`);

  // Baseline: local aggregates keyed by type (the reliability floor we don't want to regress below).
  // `n` and `p50ms` are recorded so a later comparison can tell how much precision the numbers carry and
  // whether the two runs were made under comparable load. Without them a rate is a number with no error
  // bar and no context — which is how a score gets argued about instead of interpreted.
  const localBaseline = Object.fromEntries(results.filter((r) => r.mode === "local").map((r) => [r.type,
    { singleShotRate: r.agg.singleShotRate, effectiveRate: r.agg.effectiveRate, schemaRate: r.agg.schemaRate,
      n: r.agg.n, p50ms: r.agg.p50ms }]));

  if (SAVE_BASELINE) {
    await writeFile(BASELINE_FILE, JSON.stringify({ at: report.at, reps: REPS, local: localBaseline }, null, 2));
    console.log(`\nSaved baseline → eval/baseline.json (local rates, ${REPS} reps).`);
  }

  if (CHECK_BASELINE) {
    let base;
    try { base = JSON.parse(await readFile(BASELINE_FILE, "utf8")); }
    catch { console.error("\nNo eval/baseline.json — run with --save-baseline first."); process.exit(2); }
    // These rates are measured over n = reps × CASES, not over reps — at the default 5 reps and 4
    // criteria cases n is 20, so one sample is worth 5%, not 20%. (I first wrote this block using 1/reps
    // and concluded the 15% gate could never pass. That was wrong: a 5% resolution against a 15%
    // tolerance is fine, and the red gate was a real 4-out-of-20 difference, not a rounding artifact.)
    //
    // Two things still belong here:
    //  1. A tolerance finer than 1/n cannot be met, so floor it at 1/n and show the arithmetic.
    //  2. Report p50 alongside, because MACHINE LOAD confounds single-shot rate and the gate cannot see
    //     it. Measured 2026-07-31 on identical code and cases, hours apart: criteria single-shot 78%
    //     (n=32), 80% (n=20, p50 9173ms), and 100% (n=60, p50 4227ms). The two low scores were taken
    //     while the test suite, the live e2e and a server restart were competing for the same Ollama; the
    //     100% run had the machine to itself. `effective` and `schema-valid` were 100% in all three, so
    //     the ladder absorbed every first-shot miss and no run ever received invalid JSON. A single-shot
    //     drop next to a doubled p50 is a statement about the machine, not the model — flag it, so nobody
    //     re-baselines over it or goes hunting a prompt regression that was never there.
    const regressions = [], noise = [], caveats = [];
    for (const [type, cur] of Object.entries(localBaseline)) {
      const b = base.local?.[type]; if (!b) continue;
      const nCur = Number(cur.n) || 0, nBase = Number(b.n) || 0;
      const res = Math.max(nCur ? 1 / nCur : 0, nBase ? 1 / nBase : 0);
      const effTol = Math.max(TOL, res);
      if (!nBase) caveats.push(`${type}: the baseline records no sample count (it predates that field), so its precision is unknown`);
      if (effTol > TOL) caveats.push(`${type}: tolerance floored ${pct(TOL)} → ${pct(effTol)} — one sample is worth ${pct(res)} at n=${Math.min(...[nCur, nBase].filter(Boolean))}`);
      if (b.p50ms && cur.p50ms) {
        const ratio = Math.max(cur.p50ms / b.p50ms, b.p50ms / cur.p50ms);
        if (ratio >= 1.5) caveats.push(`${type}: p50 ${b.p50ms}ms → ${cur.p50ms}ms (${ratio.toFixed(1)}× apart) — NOT comparable load; treat a single-shot difference as suspect before believing it`);
      }
      for (const metric of ["singleShotRate", "effectiveRate", "schemaRate"]) {
        const drop = (b[metric] ?? 0) - (cur[metric] ?? 0);
        const line = `${type}.${metric}: ${pct(b[metric])} → ${pct(cur[metric])} (−${pct(drop)}, n ${nBase || "?"} → ${nCur || "?"})`;
        if (drop > effTol) regressions.push(line);
        else if (drop > 0) noise.push(line);
      }
    }
    if (caveats.length) console.log(`\nHow to read this comparison:\n  ${caveats.join("\n  ")}`);
    if (noise.length) console.log(`\n~ within one sample, NOT treated as a regression:\n  ${noise.join("\n  ")}`);
    if (regressions.length) {
      console.error(`\n✗ REGRESSION vs baseline:\n  ${regressions.join("\n  ")}`);
      console.error(`  Before re-baselining: was the machine idle? Re-run with nothing else touching Ollama.`);
      process.exit(1);
    }
    console.log(`\n✓ No regression vs baseline.`);
  }
}

main().catch((e) => { console.error("\neval failed:", e.stack || e.message); process.exit(1); });
