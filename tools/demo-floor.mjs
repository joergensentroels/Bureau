#!/usr/bin/env node
// PROVE the hard floor, don't describe it.
//
//   node tools/demo-floor.mjs
//
// The README's central claim is that the approval floor for real-world actions is CODE, not
// configuration — that no autonomy tier, policy rule or autoApprove flag can lower it. That is exactly
// the kind of claim a reader has no reason to believe, and a screen recording would not settle it either:
// a GIF shows one path once, goes stale silently, and cannot be diffed.
//
// So this sweeps EVERY combination of the settings that could plausibly open the gate, against the real
// `decideApproval` the server uses, and prints the result. It needs no Latch, no model, no network and no
// state — a stranger can run it seconds after cloning, and it runs in the pure test set so the claim
// cannot rot without something going red.
//
// Exit 1 if any hard-floored action was auto-approved in any configuration, so this is a proof and a
// regression test at once.
import { decideApproval } from "../server.mjs";

const HARD_FLOOR = ["shell", "api_call", "email_draft", "github_repo", "github_pr", "github_issue", "github_comment", "mcp_call"];
const SAFE = ["web_search", "web_research", "read_file", "read_issues", "file_write", "note", "ask_peer"];
const TIERS = ["supervised", "trusted", "autonomous"];
const POLICY = ["none", "allow", "require", "block"];

// Deliberately the most permissive world that can be configured: the highest tier, a policy rule
// explicitly ALLOWING the action, autoApprove on, and a spend ceiling high enough to swallow anything.
const PERMISSIVE = { autoApproveUnderUsd: 1_000_000 };
// Colour only when a human is watching. Piped into a file, a CI log or a README code fence the escape
// codes render as literal noise - and pasting this output somewhere is half the point of the tool.
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = wrap(1), red = wrap(31), green = wrap(32);

let escaped = 0, checks = 0;

console.log(bold("\nBureau — the hard floor is code, not configuration\n"));
console.log("Sweeping every autonomy tier x policy effect x autoApprove, with a $1,000,000 spend ceiling.");
console.log("A hard-floored action must require a human in ALL of them.\n");

// ---- the floor -------------------------------------------------------------
const width = Math.max(...HARD_FLOOR.map((a) => a.length)) + 2;
console.log(`  ${"action".padEnd(width)}${"configurations tried".padEnd(24)}auto-approved in`);
console.log(`  ${"-".repeat(width + 24 + 16)}`);
for (const act of HARD_FLOOR) {
  let tried = 0, auto = 0;
  for (const tier of TIERS) for (const policyEffect of POLICY) for (const runAutoApprove of [false, true]) {
    tried++; checks++;
    const d = decideApproval(tier, act, { command: "$1 trinket" }, PERMISSIVE, runAutoApprove, policyEffect);
    if (d.auto) { auto++; escaped++; }
  }
  const verdict = auto === 0 ? green("0 — always asks a human") : red(`${auto} — FLOOR BREACHED`);
  console.log(`  ${act.padEnd(width)}${String(tried).padEnd(24)}${verdict}`);
}

// ---- the contrast, which is what makes the floor meaningful rather than a blanket "no" ----
console.log(bold("\nAnd the gate is not simply always closed:\n"));
console.log(`  ${"action".padEnd(width)}${"trusted + autoApprove".padEnd(24)}approver`);
console.log(`  ${"-".repeat(width + 24 + 16)}`);
for (const act of SAFE) {
  const d = decideApproval("trusted", act, {}, PERMISSIVE, true, "none");
  checks++;
  console.log(`  ${act.padEnd(width)}${(d.auto ? green("auto-approved") : "gated").padEnd(24)}${d.approver || "you"}`);
}

// ---- the one that depends on AMOUNT rather than type ------------------------
console.log(bold("\nPurchases are floored by the ceiling you set, not by type:\n"));
const gr = { autoApproveUnderUsd: 10 };
for (const [label, next] of [["$4 sticker pack (under the $10 ceiling)", { command: "$4 sticker pack" }],
                             ["$40 subscription (over it)", { command: "$40 subscription" }]]) {
  const d = decideApproval("autonomous", "purchase", next, gr, true, "allow");
  checks++;
  console.log(`  ${label.padEnd(width + 24)}${d.auto ? green("auto-approved") : red("requires you")}`);
}

console.log(`\n${checks} decisions evaluated against the server's own decideApproval().`);
if (escaped) {
  console.log(red(`\nFAIL — ${escaped} hard-floored decision(s) auto-approved. The floor is broken.\n`));
  process.exit(1);
}
console.log(green("\nThe floor held in every configuration. No tier, policy or flag can lower it.\n"));
console.log("Why it cannot be lowered from outside either: the floor lives in requiresCeoAlways() in");
console.log("server.mjs, reachable from no API — and Bureau holds no credentials, so even an approval it");
console.log("wrongly granted itself would have nothing to execute with. Latch does the acting.\n");
