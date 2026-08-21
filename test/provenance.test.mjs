// Provenance: untrusted content entering a run removes the standing grant for writes.
//
// WHAT THIS IS FOR, measured rather than imagined. The hard floor stops shell, api_call, email_draft,
// mcp_call, github_repo, github_issue, github_comment, github_pr and over-ceiling purchases. What it does
// not stop is what an `autonomous` tier, a run-level autoApprove, or a policy `allow` grants unattended:
// file_write, plan_add and github_file. The last of those COMMITS to a GitHub repository. And read_issues
// is safe-tier, so it auto-approves at trusted tier and above.
//
// So the sequence that motivated this is: a scheduled autonomous run reads a repository's issues, an
// attacker has filed one containing an instruction, the model follows it, and github_file commits
// attacker-chosen content with nobody in the loop. Every step of that was permitted.
//
// The first block below asserts that gap EXISTS before the rest asserts it is closed. Without it,
// "tainted → auto=false" is satisfied just as well by an action that was never auto-approvable, and the
// suite would pass while measuring nothing.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideApproval, armTaint, isTainted, taintDemotes, POLICY_ACTIONS } from "../server.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra === undefined ? "" : "  " + JSON.stringify(extra))); }
};

const auto = (tier, act, opts = {}) =>
  decideApproval(tier, act, opts.next || {}, opts.gr || {}, opts.run || false, opts.policy || "none", opts.tainted || false).auto;

const WRITES = ["file_write", "plan_add", "github_file"];

console.log("# the gap this closes — asserted FIRST, or the rest measures nothing");
{
  for (const a of WRITES)
    chk(`  CONTROL: autonomous tier auto-approves ${a} on a clean run`, auto("autonomous", a) === true);
  chk("  CONTROL: and a run-level autoApprove does too",
      WRITES.every((a) => auto("safe", a, { run: true }) === true));
  chk("  CONTROL: and a policy allow does too",
      WRITES.every((a) => auto("safe", a, { policy: "allow" }) === true));
  // The other half of the sequence: the untrusted read is itself freely available.
  chk("  CONTROL: read_issues auto-approves at trusted tier, so third-party text arrives unattended",
      auto("trusted", "read_issues") === true);
}

console.log("# tainted — the standing grant for writes is gone");
{
  for (const a of WRITES)
    chk(`  ${a} needs a human once the run is tainted`, auto("autonomous", a, { tainted: true }) === false);
  chk("  a run-level autoApprove does not survive the taint either",
      WRITES.every((a) => auto("safe", a, { run: true, tainted: true }) === false));
  // AFTER policy on purpose: an operator who loosened file_write for convenience did not thereby consent
  // to a web page deciding what gets written.
  chk("  and a policy `allow` cannot re-open it",
      WRITES.every((a) => auto("safe", a, { policy: "allow", tainted: true }) === false));
}

console.log("# and nothing else changes — a gate that refuses everything is not a gate");
{
  // THE PERMANENT NEGATIVE CONTROL. If the demotion ever widened to match everything, every assertion
  // above would still pass while the whole system quietly stopped running unattended.
  const unaffected = POLICY_ACTIONS.filter((a) => !WRITES.includes(a));
  const changed = unaffected.filter((a) => auto("autonomous", a) !== auto("autonomous", a, { tainted: true }));
  chk("  the taint changes the answer for EXACTLY the three writes", changed.length === 0, changed);
  chk("  read-only work is untouched",
      ["read_repo", "read_file", "read_issues", "web_search"].every((a) => auto("autonomous", a, { tainted: true }) === true));
  chk("  so is the review path, which has no writes to lose",
      ["register_finding", "propose_lens", "propose_harness_note", "note"].every((a) => auto("autonomous", a, { tainted: true }) === true));
  chk("  taintDemotes names those three and no others",
      POLICY_ACTIONS.filter(taintDemotes).sort().join(",") === WRITES.slice().sort().join(","));
}

console.log("# the floor is still the stronger statement");
{
  // The taint must not be able to look like it has authority over the floor, in either direction: a
  // floored action stays refused whether tainted or not, and the taint must not accidentally AUTHORISE.
  for (const a of ["shell", "api_call", "email_draft", "mcp_call", "github_pr", "github_issue"]) {
    chk(`  ${a} is refused clean`, auto("autonomous", a) === false);
    chk(`  ${a} is refused tainted`, auto("autonomous", a, { tainted: true }) === false);
  }
}

console.log("# arming it — only real content, only on success, and it sticks");
{
  const run = {};
  chk("  a fresh run is not tainted", isTainted(run) === false);
  chk("  a FAILED web_search does not taint — no content came in", armTaint(run, "web_search", false) === false && !isTainted(run));
  chk("  a successful read_repo does not taint — the operator's own repository", armTaint(run, "read_repo", true) === false && !isTainted(run));
  chk("  nor does read_file — the operator's own disk", armTaint(run, "read_file", true) === false && !isTainted(run));
  chk("  a successful read_issues DOES taint — anyone can file one", armTaint(run, "read_issues", true) === true && isTainted(run));
  chk("  and it records what caused it", run.taintedBy === "read_issues");

  // Sticky: a later clean action cannot wash it out. A run that has read attacker text stays a run that
  // has read attacker text, and the whole point is that later turns are the dangerous ones.
  armTaint(run, "read_repo", true);
  chk("  a later clean action does not clear it", isTainted(run) && run.taintedBy === "read_issues");

  for (const a of ["web_search", "web_research", "mcp_call"]) {
    const r = {};
    chk(`  ${a} taints`, armTaint(r, a, true) === true && isTainted(r));
  }
  // mcp_call is floored, so the CALL always needs a human — it is listed because its RESULT still enters
  // the context, and the taint is about content rather than about permission.
  chk("  armTaint tolerates a missing run rather than throwing", armTaint(null, "web_search", true) === false);
}

console.log("# WIRED — at the one place all 42 dispatcher branches pass through");
{
  // Derived from source, not from a run: the value of arming inside emitAct is that a branch written later
  // is covered without anybody remembering, and that property is only true while the call is still there.
  const src = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  chk("  emitAct arms the taint", /const emitAct = \(d\) => \{ armTaint\(run, d && d\.actionType, d && d\.ok\);/.test(src));
  chk("  and the decision site passes it", /decideApproval\(tier, actType, next, gr, run\.autoApprove, polEffect, isTainted\(run\)\)/.test(src));
  // If this count drops, branches have been consolidated and the "one place covers all of them" claim
  // needs re-checking rather than assuming.
  const branches = (src.match(/emitAct\(/g) || []).length;
  chk("  and emitAct is still the common path for every branch", branches >= 40, branches + " call sites");
}

if (fail) { console.error(`\nFAILURES ✗ — ${pass} passed, ${fail} failed`); process.exit(1); }
console.log(`\nALL PASS ✓ — ${pass} passed, 0 failed`);
