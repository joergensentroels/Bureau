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

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
