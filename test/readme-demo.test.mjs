// The README pastes tools/demo-floor.mjs output as evidence. A pasted transcript is a claim, and claims
// go stale — silently, because nothing re-reads a code fence. This pins the fence to the tool.
//
// It exists because the transcript was nearly shipped on a bad signal in BOTH directions: a hand-written
// PowerShell check reported a MISMATCH that did not exist (an em-dash mangled crossing into PowerShell,
// the same encoding boundary that has bitten this repo repeatedly), and had it reported a false match
// instead, a drifting README would have shipped unnoticed.
//
// Deliberately NOT whole-block equality: the README trims the middle section for length, and a test that
// forbids editorial trimming would just get deleted the first time someone shortens the fence. So it pins
// the LOAD-BEARING lines — every hard-floored action's verdict row, the decision count, and the final
// verdict — which are exactly the parts a reader would be misled by if they drifted.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
};

// NO_COLOR so the comparison can never depend on whether the runner is a TTY.
const live = execFileSync(process.execPath, ["tools/demo-floor.mjs"], {
  cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
});
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

ok("demo-floor output carries no ANSI escapes when NO_COLOR is set", !/\[/.test(live));

// Every hard-floored action must appear in the README with the same verdict the tool just produced.
const rows = live.split("\n").filter((l) => /always asks a human|FLOOR BREACHED/.test(l));
ok("the tool reported a verdict row per hard-floored action", rows.length === 8, `got ${rows.length}`);
for (const row of rows) {
  const action = row.trim().split(/\s+/)[0];
  ok(`README shows the live verdict row for ${action}`, readme.includes(row.trim()), row.trim());
}

// The count and the conclusion — the two lines a skimmer actually reads.
const count = live.match(/^\d+ decisions evaluated.*$/m)?.[0];
ok("tool printed a decision count", !!count, "no count line");
if (count) ok("README quotes the live decision count", readme.includes(count), count);

const verdict = live.match(/^The floor held in every configuration.*$/m)?.[0];
ok("tool printed the verdict line", !!verdict);
if (verdict) ok("README quotes the live verdict line", readme.includes(verdict), verdict);

// And the contrast section must still be represented, or the README reads as a blanket refusal.
ok("README shows that safe actions DO auto-approve", /web_search\s+auto-approved/.test(readme));

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
