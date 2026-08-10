// The probe gate against a REAL git repository — worktree, real check command, real edit, real revert.
//
// units.test.mjs drives verifyFinding with fakes, which proves the decision logic and nothing about whether the
// worktree machinery works. This builds a throwaway repo with a genuinely failing test, and asks the gate to confirm a
// genuine finding and refuse three fabricated ones. It is the difference between "the judge decides correctly" and "the
// courtroom exists", and this project has now been bitten twice by only checking the first.
//
//   run:  node test/finding-gate.test.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFindingIo, verifyFinding, findingRepo } from "../server.mjs";

let pass = 0, fail = 0;
const chk = (label, cond) => { console.log(`${cond ? "✓" : "✗"} ${label}`); cond ? pass++ : fail++; };

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });

// A repo whose test suite FAILS: src says 10, the test wants 42. The "defect" is the 10.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "bureau-gate-repo-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "value.mjs"), "export const value = 10;\n");
  writeFileSync(join(dir, "test", "v.test.mjs"),
    'import { value } from "../value.mjs";\n'
    + 'if (value !== 42) { console.error("value is " + value + ", wanted 42"); process.exit(1); }\n'
    + 'console.log("ok");\n');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "gate-fixture", private: true, type: "module", scripts: { test: "node --test test/v.test.mjs" } }, null, 2) + "\n");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "gate@example.invalid");
  git(dir, "config", "user.name", "gate");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture with a failing test");
  return dir;
}

const repo = makeRepo();
const CHECK = "node --test test/v.test.mjs";
try {
  console.log("# the courtroom exists — a worktree is made, used, and removed");
  {
    let sawWorktree = false;
    const before = readdirSync(repo);
    const out = await withFindingIo(repo, async (io) => { sawWorktree = (await io.sh("node --test test/v.test.mjs")).ok === false; return "ran"; });
    chk("  withFindingIo succeeded", out.ok === true && out.result === "ran");
    chk("  the check really ran inside the worktree and failed", sawWorktree === true);
    // git worktree list must be back to one, and the repo dir must not have gained anything.
    const list = String(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" })).trim().split("\n");
    chk("  the worktree was removed afterwards", list.length === 1);
    chk("  the operator's tree is untouched", JSON.stringify(readdirSync(repo)) === JSON.stringify(before));
  }

  console.log("# a REAL finding is confirmed, with the three observations");
  {
    const finding = { claim: "value is 10 and the suite wants 42", class: "B", where: "value.mjs:1", check: CHECK,
                      fix: { file: "value.mjs", find: "export const value = 10;", replace: "export const value = 42;" } };
    const out = await withFindingIo(repo, (io) => verifyFinding(finding, io));
    const v = out.result;
    chk("  confirmed", out.ok === true && v.ok === true);
    chk("  fails before the fix", v.obs?.before === false);
    chk("  passes after the fix", v.obs?.after === true);
    chk("  fails again once reverted", v.obs?.again === false);
  }

  console.log("# fabrications are refused, against the real machinery");
  {
    // A check that already passes: the test that ALREADY succeeds cannot be evidence of a defect.
    writeFileSync(join(repo, "test", "ok.test.mjs"), 'console.log("always fine");\n');
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "add a passing test");
    const out = await withFindingIo(repo, (io) => verifyFinding(
      { claim: "something is wrong", class: "B", where: "value.mjs:1", check: "node --test test/ok.test.mjs",
        fix: { file: "value.mjs", find: "10", replace: "42" } }, io));
    chk("  a check that already passes is refused", out.result?.ok === false && /passes already/.test(out.result.reason));
  }
  {
    // An anchor that is not in the file: the model imagined the line it was fixing.
    const out = await withFindingIo(repo, (io) => verifyFinding(
      { claim: "c", class: "B", where: "value.mjs:1", check: CHECK,
        fix: { file: "value.mjs", find: "export const nothing = here;", replace: "x" } }, io));
    chk("  an imagined anchor is refused", out.result?.ok === false && /anchor text was not found/.test(out.result.reason));
  }
  {
    // A fix that changes the wrong thing: applies cleanly, check still fails.
    const out = await withFindingIo(repo, (io) => verifyFinding(
      { claim: "c", class: "B", where: "value.mjs:1", check: CHECK,
        fix: { file: "value.mjs", find: "export const value = 10;", replace: "export const value = 11;" } }, io));
    chk("  a fix that does not make the check pass is refused", out.result?.ok === false && /does not make the check pass/.test(out.result.reason));
  }
  {
    // A repo that is not a repo: the gate must say so rather than throw or silently confirm.
    const notRepo = mkdtempSync(join(tmpdir(), "bureau-gate-norepo-"));
    const out = await withFindingIo(notRepo, async () => "should not run");
    chk("  a path that is not a git repo is refused with a reason", out.ok === false && /could not make a worktree/.test(out.reason));
    chk("  and nothing was left behind", existsSync(notRepo));
    rmSync(notRepo, { recursive: true, force: true });
  }

  console.log("# the guardrail");
  chk("  findingRepo reads guardrails.findingRepo", findingRepo({ guardrails: { findingRepo: " /x/y " } }) === "/x/y");
  chk("  and is empty when unset, so nothing can be verified by accident", findingRepo({}) === "" && findingRepo(null) === "");
} finally {
  rmSync(repo, { recursive: true, force: true });
}


// ---- every shape the allowlist permits, not just the convenient one -------------------------------------------
//
// This exists because `npm test` was IMPOSSIBLE on Windows for as long as the gate had existed and fifteen green
// assertions here said nothing about it: execFile refuses to spawn a .cmd and throws synchronously, so the promise
// never settled. Every fixture used `node --test`. The allowlist is the gate's contract; a contract with an
// untested branch is a guess.
{
  const repo = makeRepo();   // value is 10, the suite wants 42 — so `npm test` FAILS here
  try {
    const viaNpm = { claim: 'value is 10 and the suite wants 42', class: 'B', where: 'value.mjs:1',
                     check: 'npm test', fix: { file: 'value.mjs', find: '10', replace: '42' } };
    const out = await withFindingIo(repo, (io) => verifyFinding(viaNpm, io));
    const v = out.ok ? out.result : { ok: false, reason: out.reason };
    chk('a finding is confirmed through `npm test`, not only through `node --test`' + (v.ok ? '' : ' — got: ' + v.reason), v.ok === true);
    chk('and all three observations came from npm: ' + JSON.stringify(v.obs || {}), !!v.obs && v.obs.before === false && v.obs.after === true && v.obs.again === false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
  // The control: npm must be able to report a PASSING check too, or 'confirmed' above only proves it ran at all.
  const passing = makeRepo();
  writeFileSync(join(passing, 'value.mjs'), 'export const value = 42;' + String.fromCharCode(10));
  git(passing, 'add', '-A');
  git(passing, 'commit', '-q', '-m', 'now the suite passes');
  try {
    const bogus = { claim: 'nothing is wrong here', class: 'B', where: 'value.mjs:1',
                    check: 'npm test', fix: { file: 'value.mjs', find: '42', replace: '43' } };
    const o2 = await withFindingIo(passing, (io) => verifyFinding(bogus, io));
    const v2 = o2.ok ? o2.result : { ok: false, reason: o2.reason };
    chk('and npm reporting a PASSING check refuses the claim: ' + (v2.reason || 'confirmed?!'), v2.ok === false && /passes already/.test(v2.reason || ''));
  } finally { rmSync(passing, { recursive: true, force: true }); }
}
// An anchor that matches in more than one place used to patch the FIRST match — which is not necessarily the site
// the finding named. Measured on a real repo: a fix aimed at one route landed on another, left the defect in place,
// and the run reported 'the fix does not make the check pass'. Here the first match is deliberately the wrong one.
{
  const repo = makeRepo();
  // other comes FIRST, so a bare '10' anchor patches the line that does not matter.
  writeFileSync(join(repo, 'value.mjs'), 'export const other = 10;' + String.fromCharCode(10) + 'export const value = 10;' + String.fromCharCode(10));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'two tens, the first one irrelevant');
  try {
    const ambiguous = { claim: 'value is 10 and the suite wants 42', class: 'B', where: 'value.mjs:2',
                        check: 'node --test test/v.test.mjs', fix: { file: 'value.mjs', find: '10', replace: '42' } };
    const o = await withFindingIo(repo, (io) => verifyFinding(ambiguous, io));
    const v = o.ok ? o.result : { ok: false, reason: o.reason };
    chk('an anchor matching twice is refused, not applied to the first match: ' + (v.reason || 'CONFIRMED?!'),
        v.ok === false && /does not identify one place/.test(v.reason || ''));
    chk('  and the refusal reports how many times it matched', (v.obs || {}).anchor === 2);
    // Nothing was patched. Reading `repo` would NOT establish that — apply() works inside a throwaway worktree, so the
    // source tree is untouched either way and the assertion would pass vacuously. What discriminates is that the gate
    // never reached its second observation: no `after` means apply() short-circuited instead of editing and re-running.
    chk('  and the check was never re-run, so nothing was patched', (v.obs || {}).after === undefined);
    // THE CONTROL: same repo, same defect, a UNIQUE anchor. This must confirm, or the refusal above proves nothing.
    const unique = { ...ambiguous, fix: { file: 'value.mjs', find: 'value = 10', replace: 'value = 42' } };
    const o2 = await withFindingIo(repo, (io) => verifyFinding(unique, io));
    const v2 = o2.ok ? o2.result : { ok: false, reason: o2.reason };
    chk('  while a UNIQUE anchor on the same defect still confirms' + (v2.ok ? '' : ' — got: ' + v2.reason), v2.ok === true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES ✗"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
