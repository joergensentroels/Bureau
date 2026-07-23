// Pure unit tests for the approval-decision core: autonomy tiers, the hard floor, and declarative
// policy rules. No server or Latch needed — imports the exported functions directly.
//   run:  node test/decision.test.mjs
import { decideApproval, evaluatePolicy } from "../server.mjs";

let pass = 0, fail = 0;
function chk(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const okk = g === w;
  console.log(`${okk ? "✓" : "✗"} ${label}` + (okk ? "" : `\n    got ${g}\n    want ${w}`));
  okk ? pass++ : fail++;
}
const gr = { autoApproveUnderUsd: 10 };   // $10 auto-approve ceiling configured
const cheap = { command: "$4 sticker pack" };
const pricey = { command: "$40 subscription" };

console.log("# autonomy tiers + hard floor");
// supervised: nothing auto in an attended run
for (const a of ["web_search", "file_write", "note", "purchase", "shell", "api_call", "email_draft"])
  chk(`supervised ${a} stays gated`, decideApproval("supervised", a, {}, gr, false), { auto: false, approver: "" });
// trusted: safe/reversible actions auto; everything else gated
for (const a of ["web_search", "web_research", "read_file", "file_write", "note"])
  chk(`trusted ${a} auto`, decideApproval("trusted", a, {}, gr, false), { auto: true, approver: "tier:trusted" });
chk("trusted purchase stays gated", decideApproval("trusted", "purchase", cheap, gr, false), { auto: false, approver: "" });
chk("trusted shell floored", decideApproval("trusted", "shell", {}, gr, false), { auto: false, approver: "" });
chk("trusted api_call floored", decideApproval("trusted", "api_call", {}, gr, false), { auto: false, approver: "" });
chk("trusted email floored", decideApproval("trusted", "email_draft", {}, gr, false), { auto: false, approver: "" });
// autonomous: anything but the floor auto (allowlist enforced separately, upstream)
chk("autonomous file_write auto", decideApproval("autonomous", "file_write", {}, gr, false), { auto: true, approver: "tier:autonomous" });
chk("autonomous purchase-under auto", decideApproval("autonomous", "purchase", cheap, gr, false), { auto: true, approver: "tier:autonomous" });
chk("autonomous purchase-over floored", decideApproval("autonomous", "purchase", pricey, gr, false), { auto: false, approver: "" });
chk("autonomous shell floored", decideApproval("autonomous", "shell", {}, gr, false), { auto: false, approver: "" });
chk("autonomous email floored", decideApproval("autonomous", "email_draft", {}, gr, false), { auto: false, approver: "" });
chk("autonomous github_file auto (commits are NOT floored)", decideApproval("autonomous", "github_file", {}, gr, false), { auto: true, approver: "tier:autonomous" });
chk("policy allow auto-approves github_file (a commit can be loosened)", decideApproval("supervised", "github_file", {}, gr, false, "allow"), { auto: true, approver: "policy" });
chk("autonomous github_repo STILL floored (repo creation always asks)", decideApproval("autonomous", "github_repo", {}, gr, false), { auto: false, approver: "" });
chk("policy allow CANNOT auto github_repo (floor wins)", decideApproval("autonomous", "github_repo", {}, gr, false, "allow"), { auto: false, approver: "" });
// mcp_call: external tool calls are hard-floored so Bureau never auto-PATCH-approves them (Latch's
// per-tool allowlist/fingerprint guards stay authoritative). No tier, run-auto, or policy allow crosses it.
chk("autonomous mcp_call floored", decideApproval("autonomous", "mcp_call", {}, gr, false), { auto: false, approver: "" });
chk("run-auto mcp_call floored", decideApproval("supervised", "mcp_call", {}, gr, true), { auto: false, approver: "" });
chk("policy allow CANNOT auto mcp_call (floor wins)", decideApproval("autonomous", "mcp_call", {}, gr, false, "allow"), { auto: false, approver: "" });
// run-level auto-approve (the checkbox / scheduled): floor still holds
chk("run file_write auto", decideApproval("supervised", "file_write", {}, gr, true), { auto: true, approver: "run" });
chk("run purchase-over floored", decideApproval("supervised", "purchase", pricey, gr, true), { auto: false, approver: "" });
chk("run shell floored", decideApproval("supervised", "shell", {}, gr, true), { auto: false, approver: "" });
chk("run api_call floored", decideApproval("supervised", "api_call", {}, gr, true), { auto: false, approver: "" });
chk("run email floored", decideApproval("supervised", "email_draft", {}, gr, true), { auto: false, approver: "" });
// no ceiling configured: every purchase is the CEO's, even under run-auto / autonomous
chk("no-ceiling run purchase gated", decideApproval("supervised", "purchase", cheap, { autoApproveUnderUsd: 0 }, true), { auto: false, approver: "" });
chk("no-ceiling autonomous purchase gated", decideApproval("autonomous", "purchase", cheap, { autoApproveUnderUsd: 0 }, false), { auto: false, approver: "" });

console.log("\n# policy evaluation (first enabled match wins)");
const P = [
  { id: "a", enabled: true, when: { actionType: "shell" }, then: "block" },
  { id: "b", enabled: true, when: { costOver: 5 }, then: "require" },
  { id: "c", enabled: false, when: { actionType: "web_search" }, then: "allow" },  // disabled → skipped
  { id: "d", enabled: true, when: { agentId: "ag1", actionType: "web_search" }, then: "allow" },
];
chk("shell → block", evaluatePolicy(P, { actionType: "shell", agentId: "x", cost: 0 }).effect, "block");
chk("purchase $9 → require (costOver 5)", evaluatePolicy(P, { actionType: "purchase", cost: 9 }).effect, "require");
chk("purchase $3 → none", evaluatePolicy(P, { actionType: "purchase", cost: 3 }).effect, "none");
chk("web_search by ag1 → allow (c disabled)", evaluatePolicy(P, { actionType: "web_search", agentId: "ag1" }).effect, "allow");
chk("web_search by other → none", evaluatePolicy(P, { actionType: "web_search", agentId: "zzz" }).effect, "none");
chk("titleContains match", evaluatePolicy([{ id: "t", enabled: true, when: { titleContains: "invoice" }, then: "require" }], { actionType: "file_write", title: "Q3 Invoice draft" }).effect, "require");
chk("urlHost match", evaluatePolicy([{ id: "u", enabled: true, when: { urlHost: "api.github.com" }, then: "allow" }], { actionType: "api_call", urlHost: "api.github.com" }).effect, "allow");

console.log("\n# policy × tier × floor precedence (tier grants → policy loosens/tightens → floor clamps)");
chk("require overrides trusted auto", decideApproval("trusted", "file_write", {}, gr, false, "require"), { auto: false, approver: "" });
chk("require overrides run auto", decideApproval("supervised", "file_write", {}, gr, true, "require"), { auto: false, approver: "" });
chk("allow loosens supervised", decideApproval("supervised", "web_search", {}, gr, false, "allow"), { auto: true, approver: "policy" });
chk("allow loosens supervised purchase-under", decideApproval("supervised", "purchase", cheap, gr, false, "allow"), { auto: true, approver: "policy" });
// the critical guarantee: a policy 'allow' can NEVER auto-approve a floored action
chk("allow CANNOT cross floor: shell", decideApproval("autonomous", "shell", {}, gr, false, "allow"), { auto: false, approver: "" });
chk("allow CANNOT cross floor: api_call", decideApproval("supervised", "api_call", {}, gr, false, "allow"), { auto: false, approver: "" });
chk("allow CANNOT cross floor: email", decideApproval("supervised", "email_draft", {}, gr, false, "allow"), { auto: false, approver: "" });
chk("allow CANNOT cross floor: over-ceiling purchase", decideApproval("supervised", "purchase", pricey, gr, false, "allow"), { auto: false, approver: "" });

console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES ✗"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
