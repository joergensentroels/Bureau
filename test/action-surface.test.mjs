// Every action the model can reach must have somewhere to land.
//
// This repo has now shipped the same defect three times, and it has never once been noticed by reading:
//
//   `other`       — enumerated in the response schema, no dispatch branch. Observed nine times in a row after a
//                   large read: the turn fell off the end of the else-if chain in silence and the model, told
//                   nothing, repeated it until the cap.
//   `note`        — documented to the agent as the RIGHT answer for "I looked and found nothing", listed in
//                   SAFE_TIER_ACTIONS, HUNT_ACTIONS and POLICY_ACTIONS, and asserted by a test in units.test.mjs
//                   to be the one that "IS implemented". There was no branch. Worse, it could not have reached
//                   one: normalizeAction's catch-all rewrote it (measured — four of five notes written exactly as
//                   the doc line asks came out as file_write, web_research or web_search) and the turn loop's
//                   finish coercion swallowed whatever survived.
//   `email_draft` — in the schema enum, hard-floored, and mapped to an `external_contact` approval in Latch. So
//                   it cost a real human interruption and a real human decision, and THEN fell to the catch-all.
//
// The common cause is not carelessness. It is that the model-facing surface is FOUR lists in one 6,900-line file
// — the response schema enum, the prompt's action catalogue, normalizeAction's synonym table, and the dispatcher
// — and nothing compared them. Each of the three defects was introduced by someone editing one list correctly.
//
// So this is the checker rather than another correct list. Both sides are derived from server.mjs, so it cannot
// be satisfied by editing this file, and the reachable side is canonicalised by CALLING the real normalizeAction
// rather than by reasoning about what it would do — the note defect lived precisely in the gap between those two.
//
// Every parse is asserted non-empty BEFORE it is used. The empty set is a subset of everything, so a parser that
// silently returned [] would report this green forever — which is the failure mode of the assertions it replaces.
//
// What this does NOT establish, measured rather than assumed. The dispatched side is read from the source text, so
// it answers "is there a branch bearing this name", not "does that branch run". A branch made unreachable in place
// — guarded off, or after an earlier `continue` that always fires — keeps its comparison and this stays green. The
// control run for it confirmed exactly that: disabling the note branch with `&& false` left all assertions passing,
// while renaming it (the shape the real defect had — advertised, and nothing anywhere answering to the name) went
// red immediately. Closing that gap needs a turn loop driven end to end, which needs a provider and a Latch; the
// pure suite cannot have one. Both defects this file was written for were absent branches, not dead ones.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAction, decideApproval, UNEXECUTED_ACTIONS } from "../server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "server.mjs"), "utf8");
const Q = String.fromCharCode(34);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (detail ? "  — " + detail : "")); }
};

// ---------------------------------------------------------------------------
// The four lists, each read out of the source
// ---------------------------------------------------------------------------

// 1. The response schema enum: the alternatives in "actionType":"a"|"b"|...
const enumStart = SRC.indexOf(Q + "actionType" + Q + ":");
const fromEnum = SRC.slice(enumStart, SRC.indexOf(",'", enumStart)).split(Q).filter((s) => /^[a-z][a-z_]*$/.test(s));

// 2. The prompt's action catalogue: the "- name: ..." doc lines. Parsed the same way systemPrompt's own hunt
//    filter parses them, so a line this cannot see is also a line the review-round filter cannot see. Each doc
//    line is one source line, so the promise the catalogue makes about an action is kept with its name.
const docLines = new Map();
for (const chunk of SRC.split(Q + "- ").slice(1)) {
  const line = chunk.split("\n")[0];
  const m = /^([a-z][a-z_]{2,}):/.exec(line);
  if (m && !docLines.has(m[1])) docLines.set(m[1], line);
}
const fromDocs = [...docLines.keys()];

// 3. normalizeAction's synonym table: both the ALIASES the model might emit and the canonical TARGETS they
//    resolve to. Aliases are included deliberately — a synonym list pointing at a type with no branch is the
//    same defect wearing a different name, and it is the one nobody would think to look for.
const normBody = SRC.slice(SRC.indexOf("export function normalizeAction"), SRC.indexOf("\n}", SRC.indexOf("export function normalizeAction")));
const synTargets = [...new Set([...normBody.matchAll(/\bat = "([a-z_]+)"/g)].map((m) => m[1]))];
const synAliases = [...new Set([...normBody.matchAll(/\[([^\]]*)\]\.includes\(at\)/g)]
  .flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1])))];

// 4. The dispatcher, in the two comparison forms the runner actually uses.
//
//    SCOPED to runAgentTask, and that is not tidiness. Unscoped, `actType === "email_draft"` matches inside
//    requiresCeoAlways — the HARD FLOOR — and the checker would have called email_draft dispatched on the
//    strength of the very line proving it needs a human it was never going to reach a branch for. The floor and
//    the dispatcher ask about the same strings for opposite reasons; conflating them hides exactly this bug.
const runStart = SRC.indexOf("async function runAgentTask");
const catchAll = SRC.indexOf("cannot execute that action type yet");
const RUN = SRC.slice(runStart, SRC.indexOf("\n}", catchAll));
const after = (marker) => RUN.split(marker).slice(1).map((s) => s.split(Q)[0]);
const dispatched = [...new Set([
  ...after("next.actionType || " + Q + Q + ") === " + Q),
  ...after("actType === " + Q),
])].filter((s) => /^[a-z][a-z_]*$/.test(s)).sort();

const registered = Object.keys(UNEXECUTED_ACTIONS || {});

console.log("# the parses themselves, before anything is concluded from them");
ok("read the response schema enum", fromEnum.length >= 15, fromEnum.length + " parsed");
ok("read the prompt's action catalogue", fromDocs.length >= 15, fromDocs.length + " parsed");
ok("read normalizeAction's canonical targets", synTargets.length >= 15, synTargets.length + " parsed");
ok("read normalizeAction's synonyms", synAliases.length >= 60, synAliases.length + " parsed");
ok("read the dispatcher's branches", dispatched.length >= 20, dispatched.length + " parsed");
ok("the dispatcher parse is scoped below runAgentTask", runStart > 0 && catchAll > runStart && RUN.length > 20000, RUN.length + " chars");
// The scoping control. If this ever goes green the scope has been lost, and with it the ability to tell a
// hard-floor mention from an executor — which is the distinction email_draft was hiding behind.
ok("CONTROL: the hard floor's mentions are NOT counted as branches",
  !dispatched.includes("email_draft") && SRC.includes('actType === "email_draft"'),
  "requiresCeoAlways must still name it, and the dispatcher must not");

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

console.log("\n# every actionType the model can reach has a branch or a written-down reason it has none");
{
  // The fallback normalizeAction hands the dispatcher when it cannot make sense of a choice. Obtained by CALLING
  // it rather than by typing "other" here, so the checker keeps up with the function instead of with a memory.
  const fallback = normalizeAction({ type: "propose_action", actionType: "", title: "x", details: "y" }, "do a thing").actionType;
  ok("normalizeAction's own fallback was derived by calling it", /^[a-z][a-z_]*$/.test(fallback), fallback);

  const reachable = [...new Set([...fromEnum, ...fromDocs, ...synTargets, ...synAliases, fallback])].sort();
  ok("assembled the reachable set from all four surfaces", reachable.length >= 100, reachable.length + " names");

  // Canonicalise the way the runner does: whatever the model emits goes through normalizeAction first, and the
  // dispatcher only ever sees the result. A neutral payload, so the intent heuristics (URL / long document /
  // search wording) stay out of it — those are exercised on their own below.
  const canon = (n) => normalizeAction(
    { type: "propose_action", actionType: n, title: "a heading", details: "a short detail" }, "do a thing").actionType;

  const gaps = reachable.filter((r) => {
    const c = canon(r);
    return !dispatched.includes(c) && !registered.includes(c);
  }).map((r) => (canon(r) === r ? r : r + " -> " + canon(r)));

  ok("no reachable actionType lands on the catch-all (" + reachable.length + " checked against "
    + dispatched.length + " branches)", gaps.length === 0, gaps.join(", "));

  // The other direction on the register: a name listed as unimplemented that HAS a branch is a stale note, and a
  // stale exemption is how a real gap gets waved through later.
  const stale = registered.filter((r) => dispatched.includes(r));
  ok("nothing is registered as unimplemented while having a branch", stale.length === 0, stale.join(", "));
  ok("every registered exemption says where it is answered instead",
    registered.every((r) => String(UNEXECUTED_ACTIONS[r] || "").length > 20), registered.join(", "));
}

// ---------------------------------------------------------------------------
// A branch is not enough: the action has to survive the two layers above it
// ---------------------------------------------------------------------------

console.log("\n# a documented action must reach its branch, not be rewritten on the way");
{
  // The actions whose doc line PROMISES the agent they run instantly — derived from the promise itself, so the
  // set grows the moment someone makes that promise about a new action. These are the ones a rewrite escalates,
  // and the ones an approval seam would turn into a human interruption for a no-op.
  const seam = RUN.indexOf("await fileApproval(");
  ok("located the approval seam", seam > 0);
  const instant = fromDocs.filter((d) => /runs instantly/i.test(docLines.get(d) || ""));
  ok("found the actions the catalogue promises run instantly", instant.length >= 2, instant.join(", "));

  // The promise has to be kept in code, not just in the prompt. An action advertised as instant whose branch sits
  // below the approval seam files a Latch card and — on the default `supervised` tier — parks the agent for up to
  // ten minutes waiting for a human to approve something that does nothing. That is what email_draft did, and it
  // is the reason it was withdrawn rather than the reason it was kept.
  for (const act of instant) {
    const at = RUN.indexOf("actType === " + Q + act + Q);
    ok("  " + act + " is dispatched above the approval seam, as promised", at > 0 && at < seam,
      at < 0 ? "no branch found" : "branch at " + at + ", seam at " + seam);
  }

  // These are the ones a rewrite ESCALATES: turn a no-op into file_write and it writes to disk; into
  // web_research and it fetches the network. Each payload below trips one of normalizeAction's three intent
  // heuristics, which is how the note defect actually manifested rather than how it was described.
  const hazards = [
    ["a long, document-shaped body", { title: "Note on the auth paths", details: "I read every approval path in server.mjs and checked each one for a missing gate. Found none: they all route through decideApproval and the floor clamps them." }, "review the approval paths"],
    ["a URL quoted in the body", { title: "Checked the spec", details: "I read https://example.com/spec and it confirms the behaviour." }, "verify the spec"],
    ["an objective phrased as a search", { title: "Dead end", details: "I looked for a cache layer and there is not one anywhere in the source tree, so the claim cannot hold." }, "investigate and find the cache"],
    ["an objective phrased as a report", { title: "Findings", details: "I examined the retry logic in the fetch helper and concluded there is no unbounded loop; the deadline bounds it." }, "write a report on the fetch helper"],
  ];
  for (const act of instant) {
    for (const [why, fields, objective] of hazards) {
      const got = normalizeAction({ type: "propose_action", actionType: act, ...fields }, objective).actionType;
      ok("  " + act + " survives " + why, got === act, "became " + got);
    }
  }

  // The control on all of that: the heuristics must still fire for a VAGUE choice, or this has been "fixed" by
  // disabling the layer that makes the local model usable at all.
  const vague = (fields, objective) => normalizeAction({ type: "propose_action", actionType: "other", ...fields }, objective).actionType;
  ok("  CONTROL: a vague choice with a URL still becomes web_research",
    vague({ details: "see https://example.com/x" }, "go and read it") === "web_research");
  ok("  CONTROL: a vague choice with a long body still becomes file_write",
    vague({ title: "memo", command: "x".repeat(200) }, "write a memo about onboarding") === "file_write");
  ok("  CONTROL: a vague choice with search wording still becomes web_search",
    vague({ details: "need the latest numbers" }, "find the latest revenue") === "web_search");
}

console.log("\n# and must not be mistaken for a finish before the dispatcher sees it");
{
  // The turn loop coerces a propose_action into a finish when its actionType is really an end-of-work word. The
  // literal is lifted out of the source and EXECUTED, so this tracks the rule the runner applies rather than a
  // copy of it. `note` sat in that list for four commits after it became a documented action, which is why a
  // note ended the agent's task instead of being recorded.
  const m = /if \(next\.type !== "finish" && (\/\^\([a-z_|]+\)\$\/)\.test/.exec(SRC);
  ok("found the finish-coercion rule in the turn loop", !!m);
  if (m) {
    const coerces = new RegExp(m[1].slice(1, -1));
    ok("  the extracted rule still works", coerces.test("done") && !coerces.test("file_write"));
    const swallowed = fromDocs.filter((d) => coerces.test(d));
    ok("  no action the prompt documents is treated as a finish (" + fromDocs.length + " checked)",
      swallowed.length === 0, swallowed.join(", "));
    const enumSwallowed = fromEnum.filter((d) => coerces.test(d));
    ok("  nor any the response schema offers (" + fromEnum.length + " checked)",
      enumSwallowed.length === 0, enumSwallowed.join(", "));
  }
}

// ---------------------------------------------------------------------------
// email_draft: withdrawn from the model, kept on the floor
// ---------------------------------------------------------------------------

console.log("\n# email_draft is no longer offered, and the floor did not move when it went");
{
  ok("it is gone from the response schema enum", !fromEnum.includes("email_draft"));
  ok("it is not in the prompt's catalogue either", !fromDocs.includes("email_draft"));
  ok("no synonym resolves to it", !synTargets.includes("email_draft") && !synAliases.includes("email_draft"));

  // Behavioural, not textual: the removal must not have been "tidied up" into the floor as well. The most
  // permissive world that can be configured — highest tier, an explicit policy ALLOW, run auto-approve on, and a
  // ceiling big enough to swallow anything — must still come back needing a human.
  const gr = { autoApproveUnderUsd: 1_000_000 };
  const worst = decideApproval("autonomous", "email_draft", {}, gr, true, "allow");
  ok("it is still hard-floored in the most permissive configuration there is",
    worst.auto === false && worst.approver === "", JSON.stringify(worst));
  // The control: the same call for an action that is NOT floored must come back auto, or the assertion above
  // would pass on a decideApproval that had simply started refusing everything.
  const safe = decideApproval("autonomous", "web_search", {}, gr, true, "allow");
  ok("  CONTROL: the same call auto-approves an action that is not floored", safe.auto === true);
}

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
