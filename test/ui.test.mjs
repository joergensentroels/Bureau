// First automated coverage for the browser UI. Hermetic: no browser, no server, no network.
//
// Why not Playwright: a real browser suite needs a live Bureau AND a browser dependency, in a repo whose
// zero-dependency property is a stated design feature — and CI has neither. That suite would have to live
// outside both gates like e2e-autonomy, and adding a ~150 MB Chromium download to the clone-and-run story
// is an owner decision, not a test-file decision. So this covers what CAN be checked statically, which
// turns out to include a defect class no browser test would catch reliably either.
//
// 1. SYNTAX. TESTING.md has claimed the inline <script> "is syntax-checked by extracting it and running
//    node --check". Nothing automated it — it was done by hand, once, and the sentence quietly became a
//    claim about a process that did not exist. Now it is true.
//
// 2. SELECTOR INTEGRITY. 2449 lines with ~191 ids and ~45 literal lookups. A misspelled selector in
//    `$("#saveBtn")` throws no error and fails no syntax check: the lookup just returns null and the
//    control is silently dead. That is the single most likely way this UI breaks, and it is exactly what a
//    static check is good at — a browser test only catches it on the paths the test happens to walk.
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "public", "index.html"), "utf8");
const Q = String.fromCharCode(34), BT = String.fromCharCode(96);
// Proximity by indexOf. This file's newer assertions contain NO regex literals on purpose: built through a heredoc,
// a template literal and a file write, every backslash was eaten — [\s\S] arrived as [sS], a class of literal s and S.
const near = (a, b, n) => { const i = HTML.indexOf(a); return i >= 0 && HTML.indexOf(b, i) >= 0 && HTML.indexOf(b, i) - i < n; };

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
};

// ---- 1. the inline script parses -------------------------------------------
const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
ok("found the inline <script> block(s)", scripts.length > 0, `${scripts.length} found`);
const dir = mkdtempSync(join(tmpdir(), "bureau-ui-"));
try {
  scripts.forEach((code, i) => {
    const f = join(dir, `inline-${i}.js`);
    writeFileSync(f, code);
    try {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
      ok(`inline script #${i + 1} parses (${code.split("\n").length} lines)`, true);
    } catch (e) {
      ok(`inline script #${i + 1} parses`, false, String(e.stderr || e.message).split("\n").slice(0, 3).join(" | "));
    }
  });
} finally { rmSync(dir, { recursive: true, force: true }); }

// ---- 2. every literal id lookup resolves ----------------------------------
// Defined ids come from anywhere in the file: static markup AND the JS template strings that build rows
// at runtime, plus direct `.id = "x"` assignments. Missing any of those sources would invent failures.
const defined = new Set();
for (const m of HTML.matchAll(/\bid\s*=\s*["']([A-Za-z0-9_-]+)["']/g)) defined.add(m[1]);
for (const m of HTML.matchAll(/\.id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)) defined.add(m[1]);

// Only LITERAL lookups. Composed ones (`$("#row-"+id)`) cannot be checked statically and are skipped by
// construction rather than by an exclusion list that would drift.
const used = new Map();
const patterns = [
  /\$\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/g,
  /getElementById\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g,
  /querySelector\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/g,
];
for (const p of patterns) {
  for (const m of HTML.matchAll(p)) {
    const id = m[1];
    if (!used.has(id)) used.set(id, HTML.slice(0, m.index).split("\n").length);
  }
}

ok("found literal id lookups to check", used.size > 0, `${used.size} distinct`);
const dead = [...used].filter(([id]) => !defined.has(id));
ok(`every literal id lookup resolves to an id that exists (${used.size} checked against ${defined.size} defined)`,
  dead.length === 0,
  dead.map(([id, line]) => `#${id} (line ${line})`).join(", "));

// ---- 3. the controls the signed-out path depends on ------------------------
// These three were the subject of a real UI bug (a signed-out page rendering the first-run wizard over a
// live company) and of a false one (an automated browser throwing on window.prompt, which surfaced as a
// fake "server unreachable"). Pin their existence so a rename cannot quietly remove the sign-in route.
for (const id of ["app", "authWarn"]) ok(`signed-out path still has #${id}`, defined.has(id));
ok("signed-out renderer still exists", /function renderSignedOut\s*\(/.test(HTML));
ok("the sign-in control is shared, not duplicated per call site", (HTML.match(/function signIn\s*\(/g) || []).length === 1);


// ---- the investigate phase must be VISIBLE ---------------------------------
//
// A mechanism nobody can see is how a feature ends up unused — server.mjs says exactly that about its own action
// allowlist. Every event the phase emits needs a renderer, and the list is derived from the emit() calls in server.mjs
// rather than typed here, so a new event type added later fails this instead of being quietly invisible.
{
  const SERVER = readFileSync(join(ROOT, "server.mjs"), "utf8");
  const investigateEvents = [...new Set(
    [...SERVER.matchAll(/emit\(run, "(lens|round|investigated|finding|findingRejected)"/g)].map((m) => m[1]))].sort();
  ok("the phase emits the events this test knows about", investigateEvents.length === 5, investigateEvents.join(","));
  for (const ev of investigateEvents) {
    ok(`the feed renders "${ev}"`, HTML.includes(`ev.type==="${ev}"`));
    ok(`the compact history renders "${ev}"`, HTML.includes(ev + ":" + BT));
  }
  // A REFUSED claim must be as visible as a confirmed one. Hiding refusals would make an autonomous critic look
  // infallible, and the refusals are precisely how you tell one that works from one that is guessing.
  ok("a refused claim is rendered with its reason", near(Q + "findingRejected", "d.reason", 400));
  ok("a confirmed finding shows what proved it", near("ev.type===" + Q + "finding", "d.check", 500));
}
{
  // The switch and the repo field: without them the operator cannot turn this off or point it anywhere.
  ok("the guardrails form has the hunting switch", HTML.includes('id="gInv"'));
  ok("it has the round cap", HTML.includes('id="gInvR"'));
  ok("it has the finding repository field", HTML.includes('id="gRepo"'));
  ok("and all three are actually saved", HTML.includes("investigate:wrap.querySelector(" + Q + "#gInv" + Q + ").checked")
    && HTML.includes("investigateRounds:") && HTML.includes("findingRepo:"));
  // The empty case has to be explained where it is set, not only in a commit message.
  ok("an empty repository field says what that means", HTML.includes("CANNOT be verified"));
}
{
  // The scope. A guardrail with no way to set it is a guardrail nobody uses, and one whose refusal renders as
  // nothing looks identical to a round that simply never tried to leave.
  ok("the guardrails form has the scope box", HTML.includes('id="gScope"'));
  ok("and it is actually saved", HTML.includes("scopeFiles:wrap.querySelector(" + Q + "#gScope" + Q + ").value"));
  ok("the empty case is explained where it is set", HTML.includes("blank = the whole repository"));
  ok("and it says who enforces it — the entire difference from writing the same thing in the objective",
     HTML.includes("Enforced by the runner"));
  // BOTH halves. These live ~1,400 lines apart and the live one went in first; a replayed run would then have
  // shown nothing for a refusal, which is the same picture as a round that stayed in scope by itself.
  ok("the live feed renders a scope refusal", HTML.includes('ev.type==="scopeRefused"'));
  ok("and the compact history does too", HTML.includes("scopeRefused:" + BT));
}
{
  // An empty reply used to be invisible: the event existed and nothing rendered it, so a round that burned eleven
  // turns on pure reasoning looked in the UI like a round that simply did nothing. The measured case spent 29,125
  // of 29,246 output tokens thinking, and reasoning tokens are billed as output — so an empty turn is not a free
  // one, and the operator has no way to know that from a feed that shows nothing at all.
  ok("the live feed renders an empty-reply retry", HTML.includes('ev.type==="retry"'));
  ok("and the compact history does too", HTML.includes("retry:" + BT));
  // An unparseable reply was invisible too, and worse: the round produced text, found a candidate defect, and
  // registered nothing, which in the feed was indistinguishable from a round that found nothing.
  ok("an unparsed reply is rendered", HTML.includes('ev.type==="unparsed"'));
  ok("and appears in the compact history", HTML.includes("unparsed:" + BT));
  ok("the reason is shown, not just the fact", HTML.includes("d.reason"));
  ok("and it says nothing ran, which is the part that matters", HTML.includes("nothing ran"));
  ok("the reason travels with it rather than a generic label", HTML.includes("d.why"));
  ok("and it says the empty turn still cost money", HTML.includes("not a free one"));
}

// ---- the policy editor's actions vs the ones the server recognises ---------
//
// Two lists in two files, kept in step by hand — which failed. The editor offered five GitHub action types
// that POLICY_ACTIONS did not contain, and an unrecognised type there is not a dead menu entry: the
// sanitizer DROPS it and evaluatePolicy reads an ABSENT actionType as "any action", so picking one stored a
// rule matching EVERY action instead of that one. "Block github_pr for Ada" blocked everything Ada did, and
// the POST answered 201 whenever the rule carried any second condition.
//
// Both lists are parsed from source, so the check cannot be satisfied by editing this test — and each parse
// is asserted non-empty BEFORE it is used, because the empty set is a subset of everything and a parser that
// silently returned [] would report this green forever.
{
  const SERVER = readFileSync(join(ROOT, "server.mjs"), "utf8");
  // Odd-indexed split fragments are the quoted strings. No regex literals, for the reason at the top of
  // this file; no escape handling needed because neither list contains one.
  const strings = (src, open, close) => {
    const i = src.indexOf(open);
    if (i < 0) return [];
    const j = src.indexOf(close, i + open.length);
    return j < 0 ? [] : src.slice(i + open.length, j).split(Q).filter((_, k) => k % 2 === 1);
  };
  const serverActions = strings(SERVER, "export const POLICY_ACTIONS = [", "]");
  // The editor's entries are [value,label] pairs, so every other string is a value. The "" entry is
  // "(any action)" — no actionType condition at all — dropped by falsiness rather than by name, so a
  // relabelled option cannot turn that skip into a hole.
  const uiActions = strings(HTML, "const POL_ACTIONS=[", "];").filter((_, k) => k % 2 === 0).filter(Boolean);
  ok("parsed the server's POLICY_ACTIONS", serverActions.length >= 10, `${serverActions.length} parsed`);
  ok("parsed the policy editor's POL_ACTIONS", uiActions.length >= 10, `${uiActions.length} parsed`);

  const orphans = uiActions.filter((a) => !serverActions.includes(a));
  ok(`every action the policy editor offers, the server recognises (${uiActions.length} vs ${serverActions.length})`,
    orphans.length === 0, orphans.join(", "));

  // The other direction, and the one that will catch the NEXT drift: a type the runner dispatches but
  // POLICY_ACTIONS omits widens rules exactly the same way, and the dispatcher is where new types appear
  // first. Derived from the two comparison forms the runner actually uses, not from a list typed here.
  const after = (marker) => SERVER.split(marker).slice(1).map((s) => s.split(Q)[0]);
  const dispatched = [...new Set([
    ...after("next.actionType || " + Q + Q + ") === " + Q),
    ...after("actType === " + Q),
  ])].filter(Boolean).sort();
  ok("found the dispatcher's action comparisons", dispatched.length >= 15, `${dispatched.length} parsed`);
  const unpolicyable = dispatched.filter((a) => !serverActions.includes(a));
  ok(`every action type the runner dispatches can be named in a policy (${dispatched.length} checked)`,
    unpolicyable.length === 0, unpolicyable.join(", "));
}

// ---- THE INSTRUMENT: an emitted event that renders nowhere is a run the operator cannot see -------------
//
// Two lists in two files ~1,500 lines apart, kept in step by hand. This pair has already drifted three times —
// scopeRefused, retry and unparsed each shipped with ONE half present — and each was caught by a person reading
// a diff. The blocks above pin those three BY NAME, which is the shape that cannot generalise: naming the three
// that broke says nothing about the fourth. Ten more had accumulated behind them by the time anyone looked.
//
// So: derive BOTH sides from source, and assert BEHAVIOUR rather than text. handleEvent and histEventLine are
// lifted out of the page and actually CALLED, once per emitted type, against stubs that count every side effect.
// A branch that is present but cannot run — `ev.type==="x" && false`, the trap that keeps a source-grep check
// green while the call is disabled — produces no side effect and fails here. A history entry that is present but
// evaluates to nothing fails too, because the assertion reads the rendered line's INNER text, not its wrapper.
//
// The probe's own negative control is permanent and re-runs on every invocation: a type that does not exist must
// produce ZERO side effects and an EMPTY history line. If that ever starts passing, the harness has stopped
// discriminating — a catch-all renderer, a stub that fires unconditionally — and every green above it is void.
{
  const SERVER = readFileSync(join(ROOT, "server.mjs"), "utf8");

  // Both `emit(run, "` spellings agree at 78 call sites, so the plain split is not hiding a variant.
  const emitted = [...new Set(SERVER.split("emit(run, " + Q).slice(1).map((s) => s.split(Q)[0]))].filter(Boolean).sort();
  ok("parsed the event types the server emits", emitted.length >= 40, `${emitted.length} parsed`);

  // Lift a top-level function out of the page. Every one of these closes with a brace in column 0; every brace
  // INSIDE them is indented, so the first "\n}\n" is the end. A truncated slice cannot go unnoticed: it would
  // fail to compile below, and the length floor catches an empty one.
  const fnSrc = (header) => {
    const i = HTML.indexOf(header);
    if (i < 0) return "";
    const end = HTML.indexOf("\n}\n", i);
    return end < 0 ? "" : HTML.slice(i, end + 3);
  };
  const handleSrc = fnSrc("function handleEvent(ev){");
  const histSrc = fnSrc("function histEventLine(ev){");
  const critSrc = fnSrc("function critList(items, showStatus){");
  ok("lifted handleEvent out of the page", handleSrc.length > 4000, `${handleSrc.length} chars`);
  ok("lifted histEventLine out of the page", histSrc.length > 800, `${histSrc.length} chars`);
  ok("lifted critList out of the page", critSrc.length > 100, `${critSrc.length} chars`);

  // Every property of the event payload answers as a ONE-ELEMENT array, which is the single value that survives
  // all the shapes these branches reach for — .map, .length, .join, .filter, .slice, .indexOf and .toLocaleString
  // all exist on it — AND stringifies to something non-empty, so a bare `${d.x}` cannot render blank on its own.
  // No per-type fixture table, so a new event type needs no entry here to be checked.
  //
  // agent and manager are forced EMPTY on purpose. histEventLine prefixes its line with `d.agent||d.manager` and
  // that prefix is not the map entry's work: with a truthy agent, an entry set to "" still produced "Ada · " and
  // read as rendered. The first draft of this file did exactly that, and its negative control caught it. Forcing
  // the prefix empty makes the assertion measure the ENTRY, which is the thing that drifts.
  const anyData = () => new Proxy({ agent: "", manager: "" },
    { get: (t, k) => (typeof k === "symbol" ? undefined : (k in t ? t[k] : ["x"])) });

  let hits = 0;
  const bump = (v) => { hits++; return v; };
  const fakeEl = () => ({ textContent: "", value: "", disabled: false, innerHTML: "", style: {},
                          querySelector: () => fakeEl(), querySelectorAll: () => [], appendChild: () => {}, remove: () => {} });
  const thenable = { then() { return this; }, catch() { return this; } };

  let harness;
  try {
    harness = new Function("__s", `
      "use strict";
      const { addEv, $, esc, api, resetRun, loadQuestions, loadDeclinedChecks, loadDeliverables, loadPurchases,
              loadDashboard, loadGoals, loadPlan, refreshInbox, fmtUsdFine, render, streamRun, el } = __s;
      let ES = __s.ES, RUN_PAUSED = false, CUR_RUN = "r1", ORG = {}, HEALTH = null;
      ${critSrc}
      ${histSrc}
      ${handleSrc}
      return { handleEvent, histEventLine };
    `)({ addEv: () => bump(fakeEl()), $: () => bump(fakeEl()), esc: (s) => String(s == null ? "" : s),
         api: () => bump(thenable), resetRun: () => bump(), loadQuestions: () => bump(), loadDeclinedChecks: () => bump(),
         loadDeliverables: () => bump(), loadPurchases: () => bump(), loadDashboard: () => bump(), loadGoals: () => bump(),
         loadPlan: () => bump(), refreshInbox: () => bump(), fmtUsdFine: () => "$0", render: () => bump(),
         streamRun: () => bump(), el: () => fakeEl(), ES: { close: () => bump() } });
    ok("the lifted renderers compile and are callable", typeof harness.handleEvent === "function" && typeof harness.histEventLine === "function");
  } catch (e) {
    ok("the lifted renderers compile and are callable", false, String(e && e.message).slice(0, 200));
    harness = null;
  }

  if (harness) {
    // Did any branch run? Nothing in handleEvent touches a stub before the type chain, so a non-zero count means
    // some branch was entered and did something. A type with no branch falls off the end and scores zero.
    const renders = (type) => { hits = 0; try { harness.handleEvent({ type, data: anyData() }); } catch (e) { return "threw: " + String(e && e.message).slice(0, 90); } return hits > 0 ? "" : "no branch ran"; };
    // The wrapper is fixed, so the INNER text is what an entry actually contributes. An entry present but empty
    // still returns a wrapper, and would otherwise read as rendered.
    const OPEN = '<div class="dl">', CLOSE = "</div>";
    const histLine = (type) => {
      let out; try { out = harness.histEventLine({ type, data: anyData() }); } catch (e) { return "threw: " + String(e && e.message).slice(0, 90); }
      if (typeof out !== "string" || !out) return "no entry";
      const inner = out.startsWith(OPEN) && out.endsWith(CLOSE) ? out.slice(OPEN.length, -CLOSE.length).trim() : out.trim();
      return inner.length ? "" : "entry renders empty";
    };

    // ---- the permanent negative control -------------------------------------------------------------------
    // Run FIRST and asserted BEFORE the real types, so a harness that cannot say "no" is reported as broken
    // rather than as forty green ticks. This is the assertion that makes the rest of the block mean anything.
    ok("CONTROL: a type nothing emits renders nothing in the feed", renders("zzzNotAnEventType") === "no branch ran");
    ok("CONTROL: a type nothing emits has no compact-history entry", histLine("zzzNotAnEventType") === "no entry");

    const noFeed = emitted.filter((t) => renders(t) !== "");
    const noHist = emitted.filter((t) => histLine(t) !== "");
    ok(`every event the server emits renders in the live feed (${emitted.length} types exercised)`,
      noFeed.length === 0, noFeed.map((t) => `${t} (${renders(t)})`).join(", "));
    ok(`every event the server emits has a compact-history entry (${emitted.length} types exercised)`,
      noHist.length === 0, noHist.map((t) => `${t} (${histLine(t)})`).join(", "));
  }

  // The three the brief called load-bearing, pinned on the property that makes each one worth rendering at all.
  // These are about CONTENT, which the behavioural pass above cannot judge — it only knows a branch ran.
  ok("coverage NAMES the unopened files rather than counting them", near("ev.type===" + Q + "coverage", "d.unseen", 400));
  ok("and says what an unopened file means for the findings", HTML.includes("Never opened by any lens"));
  ok("gateAccept says nobody approved the shortfall", near("ev.type===" + Q + "gateAccept", "no one signed this off", 900));
  ok("and names the criteria it wrote off", near("ev.type===" + Q + "gateAccept", "d.items", 900));
  ok("a refutation shows what the refuter actually said", near("ev.type===" + Q + "refuted", "d.says", 700));
}

// ---- the declined-check register has a panel, and it reads the shape the endpoint returns ----------------
// The register shipped with two endpoints and no UI. The failure mode to guard is not "no panel" but a panel
// reading the WRONG KEY: /api/deliverables returns .files, and a loader reaching for .deliverables would show
// an empty list forever while every test stayed green. So the key is checked against the server's response.
{
  const SERVER = readFileSync(join(ROOT, "server.mjs"), "utf8");
  ok("the server still answers GET /api/declined-checks", SERVER.includes('p === "/api/declined-checks" && req.method === "GET"'));
  ok("and DELETE on one of them", SERVER.includes('p.startsWith("/api/declined-checks/") && req.method === "DELETE"'));
  // The response key, taken from the send() call rather than from memory.
  ok("the endpoint answers with a declinedChecks key", SERVER.includes("send(res, 200, { declinedChecks: list"));
  ok("the panel exists", HTML.includes('dcBox.id="declinedChecks"') && HTML.includes("async function loadDeclinedChecks()"));
  ok("and reads THAT key, not a guessed one", HTML.includes("data.declinedChecks"));
  ok("the panel is loaded on first render, not only after an event", HTML.includes("loadLenses(); loadDeclinedChecks();"));
  ok("it can drop an entry through the endpoint that exists", HTML.includes('api("DELETE","/api/declined-checks/"'));
  // The reason is the whole point of the register: a gap with no testable reason is the claim nobody examines.
  ok("each card shows the reason given", HTML.includes("Because: <b>${esc(d.because)}"));
  ok("and what would unblock it", HTML.includes("Unblocked by:"));
  ok("and the refuter's counter-argument where there is one", HTML.includes("d.refutation?"));
  ok("the empty state says what the register is for", HTML.includes("Nothing declined."));
}

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
