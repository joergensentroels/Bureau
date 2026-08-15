// probe-doctor, against fixtures it builds itself.
//
// The tool answers two questions about the finding gate's environment: is the worktree usable, and is a defect
// actually provable in it. Both were assumed here for a whole sequence of measurements before either was checked,
// so the tool's own failure modes get controls: a healthy repo must come out healthy, a red-suite repo must come
// out red, and a check that does NOT detect its defect must be reported as proving nothing rather than as a pass.
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gitSafeEnv } from "../tools/git-env.mjs";
const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "..", "tools", "probe-doctor.mjs");
let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; console.log("✓ " + name); } else { fail++; console.log("✗ " + name); } };

// The fixtures below run `git init` and `git config` in a throwaway directory. With an inherited GIT_DIR those
// land on whatever repository invoked this process instead — see tools/git-env.mjs, which this suite's own
// fixture identity (t@example.invalid) once ended up written into. Scrubbed here rather than only in the hook,
// because TESTING.md documents running this file directly.
const sh = async (cmd, args, cwd) => {
  try { const r = await run(cmd, args, { cwd, timeout: 180000, maxBuffer: 8e6, env: gitSafeEnv() }); return { ok: true, out: String(r.stdout || "") + String(r.stderr || "") }; }
  catch (e) { return { ok: false, out: String(e.stdout || "") + String(e.stderr || "") }; }
};
const doctor = (repo, ...rest) => sh(process.execPath, [TOOL, repo, ...rest]);

// A tiny real git repo: one source file with a hardcoded minimum, and a suite that does not notice.
async function makeRepo({ suiteGreen = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pd-fixture-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "test"), { recursive: true });
  await writeFile(path.join(dir, "src", "stats.mjs"),
    "export function spread(counts) {\n  if (!counts.length) return { min: 0, max: 0 };\n"
    + "  return { min: 0, max: Math.max(...counts) };\n}\n", "utf8");
  await writeFile(path.join(dir, "test", "existing.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { spread } from "../src/stats.mjs";\n'
    + `test("max works", () => { assert.equal(spread([2, 9]).max, ${suiteGreen ? 9 : 999}); });\n`, "utf8");
  await writeFile(path.join(dir, "package.json"),
    // `node --test` with no path. "node --test test/" resolves the trailing slash as a MODULE and dies with
    // MODULE_NOT_FOUND, which made the healthy fixture look red — the tool was right and the fixture was wrong.
    JSON.stringify({ name: "pd-fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2), "utf8");
  await sh("git", ["init", "-q"], dir);
  await sh("git", ["config", "user.email", "t@example.invalid"], dir);
  await sh("git", ["config", "user.name", "t"], dir);
  await sh("git", ["add", "-A"], dir);
  await sh("git", ["commit", "-q", "-m", "fixture"], dir);
  return dir;
}

const SPEC = (detects) => ({
  check: "test/__min.test.mjs",
  source: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { spread } from "../src/stats.mjs";\n'
    + (detects
        ? 'test("min is real", () => { assert.equal(spread([2, 9]).min, 2); });\n'
        // The vacuous control: asserts something already true, so it passes BEFORE the fix and proves nothing.
        : 'test("min is real", () => { assert.equal(spread([2, 9]).max, 9); });\n'),
  patch: { file: "src/stats.mjs", from: "  return { min: 0, max: Math.max(...counts) };", to: "  return { min: Math.min(...counts), max: Math.max(...counts) };" },
});

const repos = [];
try {
  // 1. A healthy repo reports healthy.
  const good = await makeRepo(); repos.push(good);
  const r1 = await doctor(good);
  chk("a healthy repo passes", r1.ok);
  chk("  and says the verdicts are about findings, not the environment", /about the findings/.test(r1.out));

  // 2. A repo whose suite is red must be caught — this is the case that silently disables verifyFinding's guard.
  const bad = await makeRepo({ suiteGreen: false }); repos.push(bad);
  const r2 = await doctor(bad);
  chk("a repo whose suite is red in a worktree FAILS", !r2.ok);
  chk("  and explains that a safety net is switched off, not just that a test failed",
      /guard when the suite was green/.test(r2.out));

  // 3. --prove with a check that really detects the defect.
  const specOk = path.join(good, "..", "spec-ok.json");
  await writeFile(specOk, JSON.stringify(SPEC(true)), "utf8");
  const r3 = await doctor(good, "--prove", specOk);
  chk("a defect with a fail-then-pass check is reported PROVABLE", r3.ok);
  chk("  the check is confirmed to fail first", /FAILS against the code as it is/.test(r3.out));
  chk("  and to pass after the fix", /PASSES once the fix is applied/.test(r3.out));
  chk("  and the wording says a failing round failed at the task, not the setup",
      /failed at the task rather than at the setup/.test(r3.out));

  // 4. THE CONTROL THAT MATTERS. A check that passes before the fix proves nothing, and must not be reported as a
  //    proof. Without this, "--prove said yes" would be satisfiable by any check at all.
  const specVacuous = path.join(good, "..", "spec-vacuous.json");
  await writeFile(specVacuous, JSON.stringify(SPEC(false)), "utf8");
  const r4 = await doctor(good, "--prove", specVacuous);
  chk("a check that passes BEFORE the fix is not accepted as a proof", !r4.ok);
  chk("  and is named as detecting nothing", /does not detect the defect/.test(r4.out));

  // 5. A patch anchor that matches zero or many times is refused rather than applied somewhere arbitrary.
  const specAmbiguous = path.join(good, "..", "spec-ambiguous.json");
  const amb = SPEC(true); amb.patch.from = "return {";
  await writeFile(specAmbiguous, JSON.stringify(amb), "utf8");
  const r5 = await doctor(good, "--prove", specAmbiguous);
  chk("an anchor matching more than once is refused", !r5.ok && /appears exactly once/.test(r5.out));

  // 6. A non-repo is refused up front rather than producing a confident nothing.
  const plain = await mkdtemp(path.join(tmpdir(), "pd-notgit-")); repos.push(plain);
  const r6 = await doctor(plain);
  chk("a directory that is not a git repository is refused", !r6.ok && /not a git repository/.test(r6.out));

  // 7. And the tool leaves no worktrees behind in the repo it inspected.
  const wtl = await sh("git", ["-C", good, "worktree", "list"], good);
  chk("no worktree is left behind", wtl.out.trim().split("\n").length === 1);
} finally {
  for (const d of repos) await rm(d, { recursive: true, force: true }).catch(() => {});
}

console.log(fail ? `\nFAILURES ✗ — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
