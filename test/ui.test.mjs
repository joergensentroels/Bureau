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

// ---- THE INSTRUMENT: a class passed to addEv with no rule behind it is an event with no signal -----------
//
// addEv sets className = "ev " + cls, so a class the stylesheet never defines is not an error and not a blank
// row: the element falls back to the base `.ev` border and renders as a neutral informational line. Two had
// drifted. `blocked` is what the unparsed, retry, scopeRefused, lensRejected and findingRejected renderers all
// pass — every "the runner refused, or the reply was unusable" event in the feed — and `done` is the
// investigation summary. Both were painted in the grey of a routine note, which in a scrolling feed is the
// same picture as the refusal never having happened.
//
// Both sides derived from source. The used side is the harder half, because the class is NOT always a literal:
// five call sites pass a ternary, one passes a local, one indexes a verdict table. A literal-only grep
// understates the set, and understating it is the failure mode that matters here — a class the parse never
// saw reads as "not used" rather than as "not styled", so the gap it was built to find is the gap it hides.
// So each call site's first argument is lifted by a quote- and bracket-aware scan, a conditional is reduced to
// its BRANCHES (the operands of the condition are not classes: `d.tier==="paid"?…` must not contribute
// "paid"), and an argument holding no literal at all is resolved through its declaration. Every call site must
// then yield something: a shape this cannot read is REPORTED, not skipped, because the alternative is a check
// whose coverage silently shrinks each time someone writes the class a new way.
{
  const SQ = String.fromCharCode(39), BS = String.fromCharCode(92);
  const isQuote = (c) => c === Q || c === SQ || c === BT;

  // Copy source from `i` until an UNNESTED character in `stops`. String bodies are copied verbatim, so a comma,
  // brace or colon inside a rendered message cannot end the scan; returns the whole remainder if nothing stops it.
  const scan = (src, i, stops) => {
    let depth = 0, out = "";
    for (; i < src.length; i++) {
      const c = src[i];
      if (isQuote(c)) {
        const q = c; out += c;
        for (i++; i < src.length; i++) {
          if (src[i] === BS) { out += src[i] + (src[i + 1] || ""); i++; continue; }
          out += src[i];
          if (src[i] === q) break;
        }
        continue;
      }
      if ("([{".indexOf(c) >= 0) { depth++; out += c; continue; }
      if (")]}".indexOf(c) >= 0) { if (depth === 0 && stops.indexOf(c) >= 0) return out; depth--; out += c; continue; }
      if (depth === 0 && stops.indexOf(c) >= 0) return out;
      out += c;
    }
    return out;
  };
  // Offset of the first unnested `ch`, or -1. `out` is a verbatim copy of what it consumed, so its length IS the offset.
  const stopAt = (expr, ch) => { const consumed = scan(expr, 0, ch); return consumed.length < expr.length ? consumed.length : -1; };
  const literals = (s) => {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (!isQuote(s[i])) continue;
      const q = s[i]; let v = "";
      for (i++; i < s.length; i++) {
        if (s[i] === BS) { v += s[i + 1] || ""; i++; continue; }
        if (s[i] === q) break;
        v += s[i];
      }
      out.push(v);
    }
    return out;
  };
  const word = (s, extra) => {
    let out = "";
    for (const ch of s) {
      if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || extra.indexOf(ch) >= 0) out += ch;
      else break;
    }
    return out;
  };
  // A conditional contributes what it can EVALUATE to. `d.ok?"approved":"error"` is two classes; the "paid" in
  // `d.tier==="paid"?"approved":"plan"` is a comparand and never reaches className.
  const branches = (expr) => {
    const q = stopAt(expr, "?");
    if (q < 0) return [expr];
    const rest = expr.slice(q + 1);
    const c = stopAt(rest, ":");
    return c < 0 ? [rest] : [...branches(rest.slice(0, c)), ...branches(rest.slice(c + 1))];
  };
  const classesIn = (expr) => branches(expr).flatMap(literals);

  // ---- the defined side: every `.ev.<name>` rule, from the page's <style> blocks ---------------------------
  let css = "", k = 0;
  while ((k = HTML.indexOf("<style", k)) >= 0) {
    const a = HTML.indexOf(">", k), b = HTML.indexOf("</style>", a);
    if (a < 0 || b < 0) break;
    css += HTML.slice(a + 1, b); k = b + 1;
  }
  ok("lifted the stylesheet out of the page", css.length > 5000, `${css.length} chars`);
  const styled = [...new Set(css.split(".ev.").slice(1).map((f) => word(f, "-")).filter(Boolean))].sort();
  ok("parsed the .ev rules the stylesheet defines", styled.length >= 12, `${styled.length}: ${styled.join(",")}`);

  // ---- the used side: every class handleEvent hands to addEv -----------------------------------------------
  const CALL = "addEv(";
  const sites = [];
  for (let i = 0; (i = HTML.indexOf(CALL, i)) >= 0; i += CALL.length) {
    if (HTML.slice(0, i).endsWith("function ")) continue;         // the definition, not a call
    const arg = scan(HTML, i + CALL.length, ",)").trim();
    let got = classesIn(arg);
    if (!got.length) {
      // `addEv(cls, …)` and `addEv(m.c, …)`. Resolved through the declaration rather than skipped: for a plain
      // local the initialiser IS the class expression, and for a table lookup only the literals under that key
      // — the rest of the entry is prose, and pulling it in would invent classes instead of finding them.
      const root = word(arg, "$"), prop = arg[root.length] === "." ? word(arg.slice(root.length + 1), "$") : "";
      const at = Math.max(HTML.lastIndexOf("const " + root + "=", i), HTML.lastIndexOf("const " + root + " =", i));
      if (root && at >= 0) {
        const init = scan(HTML, at, ";");
        got = prop ? init.split(prop + ":").slice(1).map((f) => literals(f)[0]).filter(Boolean)
                   : classesIn(init.slice(stopAt(init, "=") + 1));
      }
    }
    sites.push({ line: HTML.slice(0, i).split("\n").length, arg, got });
  }
  ok("found the addEv call sites", sites.length >= 40, `${sites.length} found`);
  // The coverage floor. A call site this cannot read contributes nothing and looks exactly like a call site
  // with nothing to contribute, so it is named here instead of quietly shrinking the set compared below.
  const unread = sites.filter((s) => !s.got.length);
  ok("every addEv call site yielded a class, so none is silently unchecked", unread.length === 0,
    unread.map((s) => `line ${s.line}: ${s.arg}`).join(" | "));
  // The empty string is the deliberate no-class call — "objective set", "hush task", "run complete" — which is
  // base styling on purpose. It is dropped AFTER the floor above, so it still counts as a call site that parsed.
  const used = [...new Set(sites.flatMap((s) => s.got))].filter(Boolean).sort();
  ok("parsed the classes handleEvent passes to addEv", used.length >= 12, `${used.length}: ${used.join(",")}`);

  // ---- THE PROPERTY ---------------------------------------------------------------------------------------
  const unstyled = used.filter((c) => !styled.includes(c));
  ok(`every class handleEvent passes to addEv has a rule behind it (${used.length} used vs ${styled.length} defined)`,
    unstyled.length === 0,
    "carries no visual signal — renders identically to a neutral note: " + unstyled.join(", "));

  // ---- permanent negative controls, re-run on every invocation ---------------------------------------------
  // The subset test must be able to say no. This voids the empty-set trap in the same assertion: were `styled`
  // empty — a stylesheet lift that missed, a rule syntax this cannot read — the filter returns every used class
  // alongside the invented one and the exact comparison fails, instead of reporting green forever.
  const gaps = (list) => list.filter((c) => !styled.includes(c)).join(",");
  ok("CONTROL: an invented class is reported unstyled, and nothing else is",
    gaps([...used, "zzzNotAnEvClass"]) === "zzzNotAnEvClass", "got: " + gaps([...used, "zzzNotAnEvClass"]));
  // The extractor must read a conditional as its branches and NOT as what its condition compares against.
  // Without this the parse contributes "paid", which has no rule and never will — a permanent false failure,
  // and one whose obvious "fix" is to add a `.ev.paid` rule for a class nothing ever sets.
  const TERNARY = "d.x===" + Q + "zzzCond" + Q + "?" + Q + "zzzA" + Q + ":" + Q + "zzzB" + Q;
  ok("CONTROL: a conditional contributes both branches and not its condition",
    classesIn(TERNARY).join(",") === "zzzA,zzzB", classesIn(TERNARY).join(","));
  ok("CONTROL: a plain literal argument survives the branch reduction unchanged",
    classesIn(Q + "zzzOnly" + Q).join(",") === "zzzOnly", classesIn(Q + "zzzOnly" + Q).join(","));
  // ...and the resolution is only worth having if it reaches. dodpass is passed by four call sites and is a
  // bare literal at none of them — it exists in `used` only through a ternary branch and a declaration lookup.
  // If it drops out, those paths have stopped working and this has narrowed to the literal call sites without
  // a single assertion going red.
  ok("CONTROL: a class reachable only through a ternary or a declaration is still counted",
    used.includes("dodpass"), used.join(","));
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

// ---- THE INSTRUMENT: a mode the server accepts that no form can send is a capability with no way in -----
//
// beginRun has taken three modes for two weeks. The UI could send two. So the hunting subsystem — the review
// rounds, the lens register, the finding gate, the coverage map, more engineering than anything else in this
// repo — was startable only by curl, and the Lenses panel sat on the same page showing the register for hunts
// the operator had no button for. Nothing failed. There is no test that fails when a feature merely has no way
// in, which is why it lasted: every part of it worked.
//
// The same shape had already shipped twice next door. POST /api/schedules coerced hunt to "single", and
// POST /api/triggers still did after the schedule fix landed — a capability reachable in principle and
// rewritten in transit. Those are caught in api.test.mjs. This catches the other half: reachable by the
// server, offered by nothing.
//
// Both sides derived, and the UI side BEHAVIOURAL. The picker's options are generated by calling the page's
// own builder against a synthetic roster, and each option value is turned into a mode by calling the page's
// own parser — so a helper that is present but produces nothing, or a parse that reads the wrong field, fails
// here instead of reading as green off the source text. Source text is used for the one thing it is the right
// tool for: proving the three FORMS route through that helper rather than hand-rolling a fourth list.
{
  const SERVER = readFileSync(join(ROOT, "server.mjs"), "utf8");
  const quoted = (s) => s.split(Q).filter((_, k) => k % 2 === 1);
  const attrValues = (html) => html.split("value=" + Q).slice(1).map((s) => s.split(Q)[0]);
  const idents = (s) => {                       // no regex literals, per the note at the top of this file
    const out = []; let cur = "";
    for (const ch of s) {
      if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "$") cur += ch;
      else { if (cur) out.push(cur); cur = ""; }
    }
    if (cur) out.push(cur);
    return out;
  };
  const lineIn = (src, marker) => { const i = src.indexOf(marker); return i < 0 ? "" : src.slice(i, src.indexOf("\n", i)); };
  const fnSrc = (src, header) => { const i = src.indexOf(header); if (i < 0) return ""; const e = src.indexOf("\n}\n", i); return e < 0 ? "" : src.slice(i, e + 3); };

  // ---- the server side: what beginRun actually accepts ---------------------------------------------------
  // TWO lines, cross-checked. beginRun normalises spec.mode into a fixed set and then picks a runner off the
  // same set. Reading only the normaliser would stay green for a mode with no runner; reading only the
  // dispatch would miss one with a runner nothing normalises to. Neither is the failure this file is for —
  // but a parse that half-worked is, and the disagreement is what exposes it.
  const beginSrc = fnSrc(SERVER, "function beginRun(spec) {");
  ok("lifted beginRun out of the server", beginSrc.length > 800, beginSrc.length + " chars");
  const normLine = lineIn(beginSrc, "const mode = spec.mode");
  const goLine = lineIn(beginSrc, "const go = mode ===");
  ok("found beginRun's mode normaliser", normLine.length > 30, normLine.trim());
  ok("found beginRun's runner dispatch", goLine.length > 30, goLine.trim());

  const modes = [...new Set(quoted(normLine))].sort();
  ok("parsed the modes beginRun normalises to", modes.length >= 3, modes.join(", "));
  // A runner is an identifier on the dispatch line that server.mjs defines as `function X(run)`. Derived,
  // not an exclusion list of keywords — and it doubles as the check that every branch has something to call,
  // which is the defect 97fda1a shipped for two other names.
  const runners = [...new Set(idents(goLine.split(Q).filter((_, k) => k % 2 === 0).join(" ")))]
    .filter((id) => SERVER.includes("function " + id + "(run)"));
  ok("every runner the dispatch names is a function that exists", runners.length >= 3, runners.join(", "));
  ok("the normaliser and the dispatch agree on how many shapes there are", runners.length === modes.length,
    `${modes.length} modes (${modes.join(",")}) vs ${runners.length} runners (${runners.join(",")})`);
  const unnormalised = [...new Set(quoted(goLine))].filter((m) => !modes.includes(m));
  ok("and the dispatch names no mode the normaliser cannot produce", unnormalised.length === 0, unnormalised.join(", "));

  // ---- the UI side: what the forms can send, by CALLING the page's own code ------------------------------
  const pickLine = lineIn(HTML, "const HUNT_PICK=");
  const optSrc = fnSrc(HTML, "function runTargetOptions(agents){");
  const specSrc = fnSrc(HTML, "function runTargetSpec(value){");
  ok("lifted the picker's option builder out of the page", optSrc.length > 200, optSrc.length + " chars");
  ok("lifted the picker's value parser out of the page", specSrc.length > 100, specSrc.length + " chars");
  ok("lifted the sentinel the two share", pickLine.length > 10, pickLine.trim());

  let picker = null;
  try {
    picker = new Function("__s", `"use strict";
      const { esc } = __s;
      let ORG = __s.ORG;
      ${pickLine}
      ${optSrc}
      ${specSrc}
      return { runTargetOptions, runTargetSpec, setOrg: (o) => { ORG = o; } };`)(
        { esc: (s) => String(s == null ? "" : s), ORG: undefined });
    ok("the lifted picker compiles and is callable",
      typeof picker.runTargetOptions === "function" && typeof picker.runTargetSpec === "function");
  } catch (e) {
    ok("the lifted picker compiles and is callable", false, String(e && e.message).slice(0, 200));
  }

  if (picker) {
    // A synthetic roster, so the options are the page's work and not the developer's company. TWO agents, so
    // "one option per agent" can be told apart from "one option".
    const roster = [{ id: "a1", name: "Ada", role: "Engineer" }, { id: "a2", name: "Bo", role: "Writer" }];

    // Exercise the call the FORMS make, which is the no-argument one reading ORG — not the explicit-roster
    // call. Measuring the property on a path no form takes is how an instrument ends up asserting something
    // nothing could have broken: an option builder that threw on `runTargetOptions()` would leave all three
    // pickers empty in the browser and every assertion below still green.
    let noArg = "(threw)";
    try { picker.setOrg(undefined); noArg = picker.runTargetOptions(); } catch (e) { noArg = "(threw: " + e.message + ")"; }
    ok("the builder survives being called before ORG loads, as the page does",
      typeof noArg === "string" && noArg.includes("__company__"), String(noArg).slice(0, 120));
    picker.setOrg({ agents: roster });
    const values = attrValues(picker.runTargetOptions());
    ok("the picker produced options for that roster, through the no-argument call the forms make",
      values.length >= 3, values.length + " values: " + values.join(", "));
    // ...and the two call shapes must not disagree, or the roster-driven controls below would be measuring
    // one path while the forms use the other.
    ok("CONTROL: the explicit-roster call and the ORG call yield the same options",
      attrValues(picker.runTargetOptions(roster)).join(",") === values.join(","),
      attrValues(picker.runTargetOptions(roster)).join(","));
    const specs = values.map((v) => picker.runTargetSpec(v));
    ok("every option value parses to a non-empty mode",
      specs.length === values.length && specs.every((s) => s && typeof s.mode === "string" && s.mode.length > 0),
      JSON.stringify(specs));
    const uiModes = [...new Set(specs.map((s) => s.mode))].sort();
    ok("the options resolve to more than one shape of run", uiModes.length >= 2, uiModes.join(", "));

    // ---- THE PROPERTY ------------------------------------------------------------------------------------
    const unreachable = modes.filter((m) => !uiModes.includes(m));
    ok(`every mode beginRun accepts is offered by a UI entry point (server: ${modes.join(",")} / `
      + `offered: ${uiModes.join(",")})`, unreachable.length === 0,
      "startable only by curl: " + unreachable.join(", "));
    // The other direction. A picker offering a mode the server does not normalise raises no error — beginRun
    // rewrites it to "single" and runs the wrong shape, which is the trigger bug seen from the UI side.
    const rewritten = uiModes.filter((m) => !modes.includes(m));
    ok("and offers nothing beginRun would silently rewrite", rewritten.length === 0, rewritten.join(", "));

    // ---- permanent negative controls, re-run on every invocation -----------------------------------------
    // The subset test must be able to say no. This voids the empty-list trap in the same assertion: if uiModes
    // were empty — a builder returning "", a parser returning undefined — the filter returns every server mode
    // alongside the invented one, and the exact-string comparison fails instead of reporting green.
    const gaps = (serverModes) => serverModes.filter((m) => !uiModes.includes(m)).join(",");
    ok("CONTROL: an invented server mode is reported unreachable, and nothing else is",
      gaps([...modes, "zzzNotAMode"]) === "zzzNotAMode", "got: " + gaps([...modes, "zzzNotAMode"]));
    // The parser must discriminate. If it answered "hunt" to anything, the property above would be satisfied
    // by a picker that offers nothing at all.
    ok("CONTROL: an unrecognised pick falls back to single, so no mode can appear by accident",
      picker.runTargetSpec("zzz-not-an-agent").mode === "single" && picker.runTargetSpec("").mode === "single",
      picker.runTargetSpec("zzz-not-an-agent").mode + " / " + picker.runTargetSpec("").mode);
    // The options must be built FROM the roster. A fixed string would satisfy every count above.
    const huntPicks = specs.filter((s) => s.mode === "hunt").map((s) => s.agentId).sort();
    ok("CONTROL: the hunt options are generated per agent from the roster passed in",
      huntPicks.join(",") === "a1,a2", huntPicks.join(",") || "(none)");
    // ...and a hunt needs an agent to be. With an empty roster there must be no hunt to pick — which is also
    // the proof that the hunt options come from the roster rather than from the template around it.
    const emptyModes = [...new Set(attrValues(picker.runTargetOptions([])).map((v) => picker.runTargetSpec(v).mode))];
    ok("CONTROL: with no agents hired there is no hunt to pick — runHunt needs one",
      !emptyModes.includes("hunt"), emptyModes.join(", "));
  }

  // ---- the forms must route through that helper, or none of the above is about the forms ------------------
  // This is the gap the behavioural pass cannot see: the helper can be perfect while a form still builds its
  // own list and its own body, which is the exact state this replaces. Three entry points, each checked on
  // both ends — the options it renders and the request it sends — and each lift floored, because an empty
  // string contains no `mode:"` either and would sail through the last assertion.
  ok("the company sentinel is written in exactly one place", HTML.split("value=" + Q + "__company__").length - 1 === 1,
    (HTML.split("value=" + Q + "__company__").length - 1) + " occurrences");
  const ENTRY = [
    ["the work panel", "function workPanel(){", "async function startRun(){"],
    ["the trigger dialog", "function openTriggerDialog(){", "function openTriggerDialog(){"],
    ["the schedule dialog", "function openScheduleDialog(){", "function openScheduleDialog(){"],
  ];
  for (const [name, renderHdr, submitHdr] of ENTRY) {
    const rSrc = fnSrc(HTML, renderHdr), sSrc = fnSrc(HTML, submitHdr);
    ok(`lifted ${name}`, rSrc.length > 300 && sSrc.length > 200, `${rSrc.length}/${sSrc.length} chars`);
    ok(`  ${name} fills its picker from the shared option builder`, rSrc.includes("runTargetOptions("));
    ok(`  ${name} builds its request through the shared parser`, sSrc.includes("runTargetSpec("));
    ok(`  ${name} names no mode of its own`, !sSrc.includes("mode:" + Q) && !sSrc.includes("mode: " + Q),
      "a hand-written mode literal is a form that will not learn the next one");
  }
}

// ---------------------------------------------------------------------------------------------------
// The escaper has to be right for the CONTEXT it is used in, and here that context is attributes.
//
// esc() covered [&<>] — correct for text content, wrong for an attribute. Most of this file's ~288 call
// sites ARE attributes: value=, title=, data-id= and 16 other names. A value containing a double quote
// closes the attribute early and what follows is parsed as markup — and that needs NEITHER < nor >:
// ` onmouseover=...` is a complete attack made only of characters esc() used to pass through. Escaping
// the angle brackets is precisely what made the gap feel closed.
//
// Asserts BEHAVIOUR, by running the real esc() lifted out of the page. A source-text check is the thing
// that let this through in the first place: "[&<>]" reads as "it escapes HTML" to anyone not thinking
// about attribute context.
// ---------------------------------------------------------------------------------------------------
{
  const from = HTML.indexOf("const esc = (s) =>");
  const line = from < 0 ? "" : HTML.slice(from, HTML.indexOf("\n", from)).trim();
  ok("lifted esc() out of the page", line.startsWith("const esc = (s) =>") && line.length > 40, line.slice(0, 60));

  // eval of the shipped expression, deliberately — what it DOES is the question.
  const expr = line.slice("const esc = ".length).replace(/;$/, "");
  const esc = eval("(" + expr + ")");
  const DQ = String.fromCharCode(34), SQ = String.fromCharCode(39);

  ok("  escapes & < > as before", esc("a & b < c > d") === "a &amp; b &lt; c &gt; d", esc("a & b < c > d"));
  ok("  escapes the double quote that would end an attribute", !esc(DQ).includes(DQ), esc(DQ));
  ok("  escapes the single quote too, for single-quoted attributes", !esc(SQ).includes(SQ), esc(SQ));

  // Stated as the attack rather than as a character list.
  const attack = DQ + " onmouseover=alert(1) x=" + DQ;
  ok("  an attribute-breakout payload can no longer close the attribute", !esc(attack).includes(DQ), esc(attack));
  ok("  and that payload contains no angle brackets at all, so escaping [&<>] would have passed it",
    !attack.includes("<") && !attack.includes(">"));

  // CONTROLS. Every assertion above is "the output lacks a character", and a function returning "" would
  // satisfy all of them. Content has to survive, and a stripped quote has to become an entity.
  ok("  control: ordinary text passes through intact", esc("Ada reviews the roster") === "Ada reviews the roster");
  ok("  control: a quote becomes an entity rather than vanishing", esc(DQ).length > 1, esc(DQ));

  // Why it matters HERE: attributes are the majority use. If this ever reads 0, the block above is
  // asserting things about a context the page no longer has.
  let attrSites = 0, at = 0;
  const needle = '="${esc(';
  while ((at = HTML.indexOf(needle, at)) >= 0) { attrSites++; at += needle.length; }
  ok("  precondition: esc() really is used inside attributes (" + attrSites + " sites)", attrSites >= 10);
}

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
