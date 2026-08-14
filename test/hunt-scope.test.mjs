// A hunting round is a REVIEW phase, and until this commit that was a SENTENCE in the prompt rather than a rule in
// the runner. The prompt said "you cannot write files, buy anything, send anything or commit"; the dispatcher blocked
// exactly two action types, shell and api_call. Everything else in the catalogue was reachable, and file_write is the
// expensive one: it is in SAFE_TIER_ACTIONS, so on a trusted agent it AUTO-APPROVES — an unattended round could write
// a deliverable with no human anywhere in the loop, and the only thing standing in the way was the model's goodwill.
//
// This project rejects that trade everywhere else and says so on its own front page — "Enforced by the runner, not
// asked of the model" — on measured grounds: asking a model to stay inside a named file set produced 44-67% compliance
// across two providers, while enforcing the same set mechanically produced 100%.
//
// What this file establishes, and the two halves are different in kind:
//
//   1. huntRefusal's own behaviour — CALLED, never read as text. Which actions it refuses, which it permits, and
//      (the property that matters most) that it permits EVERYTHING when the run is not a hunting round.
//   2. That the prompt and the enforcement read the SAME list. Both sides are obtained by calling — the surviving
//      catalogue by calling systemPrompt twice and diffing, the permitted set by calling huntRefusal on each name —
//      so a second hardcoded list in either place shows up as a disagreement instead of as a comment nobody re-reads.
//
// What it does NOT establish: that the dispatcher calls any of this. A pure suite cannot drive a turn loop. That is
// test/hunt-dispatch.test.mjs, which boots a real Bureau against a stub Latch and watches what a real run does.
import { huntRefusal, systemPrompt, decideApproval, POLICY_ACTIONS } from "../server.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (detail ? "  — " + detail : "")); }
};

// A company rich enough that every CONDITIONAL doc line is present: a configured repo turns on read_repo, and one
// external tool turns on mcp_call. Without those two the catalogue is quietly shorter and the agreement below would
// be asserting less than it appears to.
const ORG = {
  ceo: { role: "the business" },
  guardrails: { findingRepo: "C:/somewhere/repo", autoApproveUnderUsd: 0 },
  budget: { funds: 500, spent: 0 },
  questions: [],
  _mcpTools: [{ server: "latch", name: "lookup", description: "a stub tool" }],
};
const AGENT = { name: "Hunter", role: "Reviewer", traits: [], seed: "hunter-1" };

// ---------------------------------------------------------------------------
// The sets, each DERIVED by calling something rather than typed here
// ---------------------------------------------------------------------------

// The prompt's action catalogue, parsed exactly the way systemPrompt's own filter parses it (`^- name:`), so a line
// this cannot see is a line the filter cannot see either.
const catalogue = (phase) => {
  const out = [];
  for (const line of systemPrompt(ORG, AGENT, phase ? { phase } : {}).split("\n")) {
    const m = /^- ([a-z][a-z_]+):/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
};
const fullCatalogue = catalogue("");
const huntCatalogue = catalogue("investigate");

// The hard floor, derived BEHAVIOURALLY: build the most permissive world that can be configured — top autonomy tier,
// an explicit policy allow, run-level auto-approve, and a ceiling big enough to swallow any purchase — and call
// decideApproval. Anything that still comes back needing a human is on the floor. Derived rather than listed because
// a list here would go stale the day someone adds the tenth floored type, which is the exact failure this closes.
const PERMISSIVE = { autoApproveUnderUsd: 1_000_000 };
const floored = POLICY_ACTIONS.filter((a) =>
  decideApproval("autonomous", a, { command: "999999999" }, PERMISSIVE, true, "allow").auto === false);

console.log("# the derived sets, before anything is concluded from them");
ok("the full action catalogue was parsed out of a real prompt", fullCatalogue.length >= 18, fullCatalogue.length + ": " + fullCatalogue.join(","));
ok("the hunting catalogue was parsed out of a real prompt", huntCatalogue.length >= 5, huntCatalogue.length + ": " + huntCatalogue.join(","));
ok("the hunting catalogue is a strict SUBSET of the full one", huntCatalogue.length < fullCatalogue.length
  && huntCatalogue.every((a) => fullCatalogue.includes(a)),
  huntCatalogue.length + " of " + fullCatalogue.length);
ok("POLICY_ACTIONS is populated (an empty list would make every check below vacuous)", POLICY_ACTIONS.length >= 20, POLICY_ACTIONS.length + "");
ok("the hard floor was derived by calling decideApproval, not typed here", floored.length >= 8, floored.length + ": " + floored.join(","));
// The control on that derivation. If decideApproval ever started refusing everything, `floored` would swallow the
// whole catalogue and "every floored type short-circuits" would become a tautology.
ok("  CONTROL: the derivation does NOT call a safe action floored",
  !floored.includes("web_search") && !floored.includes("file_write") && !floored.includes("read_repo"),
  floored.join(","));
ok("  and it found the types this commit is about",
  ["shell", "api_call", "email_draft", "mcp_call", "github_repo", "github_issue", "github_comment", "github_pr"].every((a) => floored.includes(a)),
  floored.join(","));

// ---------------------------------------------------------------------------
// The control that matters most: an ordinary run is untouched
// ---------------------------------------------------------------------------

console.log("\n# a run that is not hunting is not narrowed by any of this");
{
  // Every phase value a non-hunting run can carry. `undefined` is the real one — run.phase is only ever assigned
  // "investigate", so a company or single run reaches the dispatcher with the property absent.
  const notHunting = [undefined, "", "construct", "review", "INVESTIGATE", "investigating"];
  const leaked = [];
  for (const phase of notHunting) {
    for (const a of POLICY_ACTIONS) {
      if (huntRefusal({ phase, actType: a, next: { command: "999999" }, gr: { autoApproveUnderUsd: 0 } }) !== null) {
        leaked.push(`${JSON.stringify(phase)}/${a}`);
      }
    }
  }
  ok(`no action is refused in any non-hunting phase (${notHunting.length} phases x ${POLICY_ACTIONS.length} actions)`,
    leaked.length === 0, leaked.slice(0, 6).join(", "));
  ok("  including a call with no arguments at all", huntRefusal() === null && huntRefusal({}) === null);
  // The control on the control: if huntRefusal had simply been written to return null always, the loop above would
  // pass and prove nothing. This is the same call shape with the one field that should change the answer.
  ok("  CONTROL: the identical call with phase=investigate DOES refuse",
    huntRefusal({ phase: "investigate", actType: "file_write", next: { command: "999999" }, gr: { autoApproveUnderUsd: 0 } }) !== null);
}

// ---------------------------------------------------------------------------
// Inside a hunting round
// ---------------------------------------------------------------------------

console.log("\n# inside a hunting round, the catalogue is the rule and not a request");
{
  const refused = POLICY_ACTIONS.filter((a) => huntRefusal({ phase: "investigate", actType: a, next: {}, gr: {} }));
  const permitted = POLICY_ACTIONS.filter((a) => !huntRefusal({ phase: "investigate", actType: a, next: {}, gr: {} }));
  ok("some actions are permitted and some are refused", permitted.length > 0 && refused.length > 0,
    permitted.length + " permitted, " + refused.length + " refused");

  // The gap this commit closes, named explicitly. file_write is safe-tier, so before this it auto-approved during an
  // unattended round; the prompt asked it not to and nothing checked.
  ok("file_write is refused — the auto-approving one that made this a real hole",
    !!huntRefusal({ phase: "investigate", actType: "file_write", next: {}, gr: {} }));
  ok("so are the other ways to leave a mark: purchase, github_file, plan_add",
    ["purchase", "github_file", "plan_add"].every((a) => refused.includes(a)), refused.join(","));

  // The second half of the commit: the unattended short-circuit used to cover 2 of the floored types. It must now
  // cover all of them, with the reason that was always true for all of them.
  const missed = floored.filter((a) => {
    const r = huntRefusal({ phase: "investigate", actType: a, next: { command: "999999999" }, gr: { autoApproveUnderUsd: 0 } });
    return !r || !/unattended/.test(r.reason);
  });
  ok(`every hard-floored type short-circuits as unattended, not just shell and api_call (${floored.length} checked)`,
    missed.length === 0, missed.join(", "));
  // `?.say` and not `.say`: under a control that makes huntRefusal permissive this must FAIL, not throw. A suite that
  // dies on a TypeError still exits non-zero, but it stops before the assertions after it — so the control would be
  // reporting on a run that never reached them.
  ok("  and each says so in a way the agent can act on, naming what it CAN do instead",
    floored.every((a) => {
      const say = huntRefusal({ phase: "investigate", actType: a, next: { command: "999999999" }, gr: { autoApproveUnderUsd: 0 } })?.say || "";
      return say.includes("register_finding") && say.includes("read_repo") && say.length > 200;
    }));
  // A purchase UNDER a configured ceiling is NOT on the floor, so it must be refused for the other reason. This is the
  // one action whose refusal depends on its arguments, and it is where a floor check that ignored `next`/`gr` would show.
  const cheap = huntRefusal({ phase: "investigate", actType: "purchase", next: { command: "4.00" }, gr: { autoApproveUnderUsd: 50 } });
  const dear = huntRefusal({ phase: "investigate", actType: "purchase", next: { command: "4000.00" }, gr: { autoApproveUnderUsd: 50 } });
  ok("a purchase under the ceiling is refused as out-of-scope, one over it as unattended",
    !!cheap && !/unattended/.test(cheap.reason) && !!dear && /unattended/.test(dear.reason),
    JSON.stringify([cheap?.reason, dear?.reason]));

  // Every refusal has to be answerable. A block that does not say what to do instead is how a round spends its
  // remaining turns re-proposing the same thing.
  ok("every refusal names an action the round can actually take",
    refused.every((a) => {
      const r = huntRefusal({ phase: "investigate", actType: a, next: { command: "999999999" }, gr: {} }) || {};
      return permitted.some((p) => String(r.say || "").includes(p)) && String(r.reason || "").length > 10 && String(r.error || "").length > 10;
    }));
}

// ---------------------------------------------------------------------------
// One list, read twice
// ---------------------------------------------------------------------------

console.log("\n# the prompt filter and the enforcement read the same list");
{
  // Both sides are CALLED. If either grew its own copy of the allowed set, this parts company immediately — which is
  // the whole reason the enforcement was written against HUNT_ACTIONS instead of repeating the two names it replaced.
  const advertisedButRefused = huntCatalogue.filter((a) => huntRefusal({ phase: "investigate", actType: a, next: {}, gr: {} }));
  const permittedButHidden = fullCatalogue.filter((a) =>
    !huntRefusal({ phase: "investigate", actType: a, next: {}, gr: {} }) && !huntCatalogue.includes(a));
  ok(`nothing the hunting prompt advertises is refused by the runner (${huntCatalogue.length} checked)`,
    advertisedButRefused.length === 0, advertisedButRefused.join(", "));
  ok(`nothing the runner permits is hidden from the hunting prompt (${fullCatalogue.length} checked)`,
    permittedButHidden.length === 0, permittedButHidden.join(", "));
  // The control: the same comparison against the UNFILTERED catalogue must fail loudly, or the two assertions above
  // would also pass in a build where the prompt filter had been removed entirely.
  const wouldBeRefused = fullCatalogue.filter((a) => huntRefusal({ phase: "investigate", actType: a, next: {}, gr: {} }));
  ok("  CONTROL: the unfiltered catalogue does NOT satisfy the same comparison", wouldBeRefused.length >= 8,
    wouldBeRefused.length + " of the full catalogue would be refused: " + wouldBeRefused.join(","));
}

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
