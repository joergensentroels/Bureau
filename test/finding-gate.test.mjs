// The probe gate against a REAL git repository — worktree, real check command, real edit, real revert.
//
// units.test.mjs drives verifyFinding with fakes, which proves the decision logic and nothing about whether the
// worktree machinery works. This builds a throwaway repo with a genuinely failing test, and asks the gate to confirm a
// genuine finding and refuse three fabricated ones. It is the difference between "the judge decides correctly" and "the
// courtroom exists", and this project has now been bitten twice by only checking the first.
//
//   run:  node test/finding-gate.test.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFindingIo, verifyFinding, findingRepo, normalizeFinding, gateNeverRan, findingTriage } from "../server.mjs";
import { gitSafeEnv } from "../tools/git-env.mjs";

let pass = 0, fail = 0;
const chk = (label, cond) => { console.log(`${cond ? "✓" : "✗"} ${label}`); cond ? pass++ : fail++; };

// env scrubbed: makeRepo() below runs `git init` and `git config user.*` in a throwaway directory, and with an
// inherited GIT_DIR none of that lands there. `git init` re-inits GIT_DIR as BARE, and the config writes go to
// the real repository — which is how this suite's own fixture identity, gate@example.invalid, was once found in
// the operator's .git/config next to a `core.bare = true` that made the repo unusable. See tools/git-env.mjs.
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: gitSafeEnv() });

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
  console.log("# a worktree carries the repo's node_modules, or every devDependency reads as a defect");
  {
    // A worktree has no node_modules. For a project with devDependencies that turns the WHOLE suite red for a
    // reason unrelated to the finding — measured against 4water, whose a11y and css-audit tests cannot load jsdom
    // or axe-core in a bare worktree.
    //
    // The damage is the quiet kind. verifyFinding applies its "this fix breaks the project's existing suite" guard
    // only when `obs.suiteBefore` was TRUE, so a suite that was already red SKIPS that guard entirely: the gate goes
    // on issuing confirmations with its safety net switched off. That is worse than refusing every finding, which
    // is what it looks like from outside.
    const dep = mkdtempSync(join(tmpdir(), "bureau-gate-dep-"));
    mkdirSync(join(dep, "test"));
    mkdirSync(join(dep, "node_modules"));
    // A "dependency" the suite imports. If the link is missing, the import throws and the suite is red.
    const LF = String.fromCharCode(10);
    writeFileSync(join(dep, "node_modules", "dep.mjs"), "export const answer = 42;" + LF);
    writeFileSync(join(dep, "test", "d.test.mjs"),
      'import { answer } from "../node_modules/dep.mjs";' + LF
      + "if (answer !== 42) process.exit(1);" + LF);
    writeFileSync(join(dep, "package.json"),
      JSON.stringify({ name: "dep-fixture", private: true, type: "module", scripts: { test: "node --test test/d.test.mjs" } }, null, 2) + LF);
    // Ignored, exactly as a real project does. Without this, `git add -A` COMMITS node_modules, the worktree gets
    // it from git rather than from the link, and the assertion below passes whether or not the fix exists. The
    // precondition caught precisely that on the first run.
    writeFileSync(join(dep, ".gitignore"), "node_modules/" + LF);
    git(dep, "init", "-q");
    git(dep, "config", "user.email", "gate@example.invalid");
    git(dep, "config", "user.name", "gate");
    git(dep, "add", "-A");
    git(dep, "commit", "-q", "-m", "fixture whose suite needs a dependency");
    // node_modules is NOT committed — that is the whole point, and it is why a worktree at HEAD lacks it.
    chk("  precondition: the dependency is untracked, so a worktree at HEAD cannot have it",
        git(dep, "ls-files").indexOf("node_modules") === -1);

    const out = await withFindingIo(dep, async (io) => (await io.suite()).ok);
    chk("  the suite passes in the worktree, because node_modules was linked in", out.ok && out.result === true);
    rmSync(dep, { recursive: true, force: true });
  }

  console.log("# a repo with no node_modules at all is still fine — the link is best-effort");
  {
    // The control. If the link were required rather than best-effort, every dependency-free project (this one
    // included) would stop being verifiable, and the fix would have traded one broken case for a broader one.
    const out = await withFindingIo(repo, async (io) => (await io.sh("node --test test/v.test.mjs")).ok);
    chk("  a repo without node_modules still runs its checks", out.ok && out.result === false);
  }

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
      { claim: "the value is 10 where the suite wants 42", class: "B", where: "value.mjs:1", check: CHECK,
        fix: { file: "value.mjs", find: "export const value = 10;", replace: "export const value = 11;" } }, io));
    chk("  a fix that does not make the check pass is refused", out.result?.ok === false && /does not make the check pass/.test(out.result.reason));

    // ---- what survives the refusal ----------------------------------------------------------------------
    //
    // This refusal is the one that cost a night. Five of the seven in run_b9we0ha_1 carried this exact sentence
    // at one location, and it is REACHABLE ONLY after the check failed against the current code and the fix's
    // anchor matched exactly once — so it means either a real defect the agent could not repair, or a probe
    // broken in a way that fails identically before and after. A human needs opposite responses to those two,
    // and the audit row stored neither the claim nor the check's output, so the cluster could not be judged.
    //
    // Fed the REAL refusal object, not a hand-made one. That is the whole point of asserting it here rather than
    // in units.test.mjs: findingTriage reads named fields off `v`, and a builder looking for a field the gate
    // does not actually produce returns undefined, writes no key, and leaves every suite green. The failure mode
    // being guarded is silence, so the assertions below demand specific CONTENT that only a real run supplies.
    const v = out.result;
    const t = findingTriage({ claim: "the value is 10 where the suite wants 42", cls: "B", check: CHECK }, v);
    chk("  the refusal carries triage evidence at all", !!t);
    chk("  it carries the claim, so the row names what was alleged", t?.claim === "the value is 10 where the suite wants 42");
    chk("  and the check, so a human can re-run it", t?.check === CHECK);
    // The fixture's test prints "value is 11, wanted 42" once the wrong fix is applied. Asserting that string
    // proves the stored output came from the process that ran AFTER the fix — not from the earlier run, and not
    // from an empty string that would satisfy a mere truthiness check on the field.
    chk("  and the check's own output, from the run after the fix: " + JSON.stringify(String(t?.out || "").slice(-60)),
        /value is 11, wanted 42/.test(String(t?.out || "")));
    chk("  and the observation triple, which is what makes the verdict reconstructible",
        t?.obs?.before === false && t?.obs?.after === false);

    // NEGATIVE CONTROLS for the three assertions above. Each one is a shape findingTriage can actually be handed
    // at runtime, and each must come back missing exactly the field the corresponding assertion demands —
    // otherwise those assertions are satisfied by the builder's defaults rather than by the refusal.
    chk("  control: nothing to store returns undefined, so an empty row gains no key",
        findingTriage({}, {}) === undefined && findingTriage(null, null) === undefined);
    chk("  control: a refusal with no output stores no out field, rather than an empty one",
        (() => { const c = findingTriage({ claim: "x" }, { reason: "r" }); return !!c && c.claim === "x" && !("out" in c); })());
    chk("  control: the caps truncate rather than being ignored",
        (() => { const c = findingTriage({ claim: "y".repeat(900), check: "z".repeat(900) }, null);
                 return c.claim.length === 401 && c.claim.endsWith("…") && c.check.length === 401; })());
    // The obs triple is copied, not aliased: the record it comes from is mutated by later turns of the same run.
    chk("  control: obs is a copy, so a later mutation cannot rewrite the stored evidence",
        (() => { const src = { before: false, after: false };
                 const c = findingTriage({ claim: "x" }, { obs: src });
                 src.after = true; return c.obs.after === false; })());
  }
  {
    // A repo that is not a repo: the gate must say so rather than throw or silently confirm.
    const notRepo = mkdtempSync(join(tmpdir(), "bureau-gate-norepo-"));
    const out = await withFindingIo(notRepo, async () => "should not run");
    // Classified by the exported predicate rather than by a copy of the message. This line used to match
    // /could not make a worktree/ as a literal, and renaming that string on the producing side turned it red
    // while the behaviour was unchanged — the reason the classifier is shared code now. It also asserts the
    // stronger property: not merely that SOME reason came back, but that the gate reports this as the machine
    // failing rather than as a judgement about the finding, which is what keeps a hunt from calling it clean.
    chk("  a path that is not a git repo is refused, and reported as the gate not running",
        out.ok === false && gateNeverRan(out.reason));
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
// ---- the probe path: a defect NO existing check catches ------------------------------------------------------
//
// The gate used to begin with "the check FAILS before the fix", so a defect nothing already tests for was refused
// on step one and the agent had no way to supply the missing check. Against a green repository it could confirm
// nothing at all. These run against a repo whose suite PASSES and which contains a real off-by-one: sum() skips
// the last element, and the shipped test only checks the empty case.
function makeGreenRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'bureau-probe-repo-'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'sum.mjs'), 'export function sum(xs) {\n  let t = 0;\n  for (let i = 0; i < xs.length - 1; i++) t += xs[i];\n  return t;\n}\n');
  writeFileSync(join(dir, 'test', 'sum.test.mjs'), 'import { sum } from "../sum.mjs";\nif (sum([]) !== 0) process.exit(1);\nconsole.log("ok");\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe-fixture', private: true, type: 'module',
    scripts: { test: 'node --test test/sum.test.mjs' } }, null, 2) + String.fromCharCode(10));
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'green suite, latent off-by-one');
  return dir;
}
const GOOD_PROBE = 'import { sum } from "../sum.mjs";\nconst got = sum([1, 2, 3]);\nif (got !== 6) { console.error("sum([1,2,3]) = " + got); process.exit(1); }\nconsole.log("ok");\n';
const THE_FIX = { file: 'sum.mjs', find: 'i < xs.length - 1', replace: 'i < xs.length' };

{
  const repo = makeGreenRepo();
  try {
    // THE CONTROL FIRST: the repo's own suite passes, so this defect is invisible to everything that exists.
    // Without this, a confirmation below could just mean the fixture was broken to begin with.
    const pre = { claim: 'sum drops the last element', class: 'off-by-one', where: 'sum.mjs:3',
                  check: 'npm test', fix: THE_FIX };
    const o0 = await withFindingIo(repo, (io) => verifyFinding(pre, io));
    const v0 = o0.ok ? o0.result : { ok: false, reason: o0.reason };
    chk('without a probe, a defect no existing check catches is refused: ' + (v0.reason || 'CONFIRMED?!'),
        v0.ok === false && /passes already/.test(v0.reason || ''));

    const withProbe = { claim: 'sum drops the last element', class: 'off-by-one', where: 'sum.mjs:3',
                        probe: { file: 'test/probe-sum.test.mjs', content: GOOD_PROBE }, fix: THE_FIX };
    const o1 = await withFindingIo(repo, (io) => verifyFinding(withProbe, io));
    const v1 = o1.ok ? o1.result : { ok: false, reason: o1.reason };
    chk('but WITH a probe the same defect is confirmed' + (v1.ok ? '' : ' — got: ' + v1.reason), v1.ok === true);
    chk('  and all four observations were made: ' + JSON.stringify(v1.obs || {}),
        !!v1.obs && v1.obs.before === false && v1.obs.after === true && v1.obs.again === false
        && v1.obs.suiteBefore === true && v1.obs.suiteAfter === true);
    chk('  and the check was derived from the probe, not taken on trust',
        (v1.finding || {}).check === 'node --test test/probe-sum.test.mjs');

    // A probe that reads the fixed file and asserts on its TEXT fails-passes-fails just like a real one, while
    // testing nothing about behaviour. This is the proxy problem, refused mechanically.
    const proxy = { ...withProbe, probe: { file: 'test/probe-proxy.test.mjs', content: 'import { readFileSync } from "node:fs";\nconst src = readFileSync(new URL("../sum.mjs", import.meta.url), "utf8");\nif (!src.includes("xs.length;")) process.exit(1);\nconsole.log("ok");\n' } };
    const o2 = await withFindingIo(repo, (io) => verifyFinding(proxy, io));
    const v2 = o2.ok ? o2.result : { ok: false, reason: o2.reason };
    chk('a probe asserting on the source TEXT is refused: ' + (v2.reason || 'CONFIRMED?!'),
        v2.ok === false && /asserts on its TEXT|reads the file it is about/.test(v2.reason || ''));

    // A probe that ignores the code cannot survive step four: reverting the fix must break it again.
    const inert = { ...withProbe, probe: { file: 'test/probe-inert.test.mjs',
                    content: 'if (1 !== 1) process.exit(1);' + String.fromCharCode(10) + 'console.log("always ok");' + String.fromCharCode(10) } };
    const o3 = await withFindingIo(repo, (io) => verifyFinding(inert, io));
    const v3 = o3.ok ? o3.result : { ok: false, reason: o3.reason };
    chk('a probe that passes regardless is refused: ' + (v3.reason || 'CONFIRMED?!'),
        v3.ok === false && /passes already/.test(v3.reason || ''));

    // A fix that repairs the named defect and breaks the existing suite is not a fix.
    const breaks = { claim: 'sum drops the last element', class: 'off-by-one', where: 'sum.mjs:3',
                     probe: { file: 'test/probe-breaks.test.mjs', content: GOOD_PROBE },
                     fix: { file: 'sum.mjs', find: 'let t = 0;', replace: 'let t = 6; return t;' } };
    const o4 = await withFindingIo(repo, (io) => verifyFinding(breaks, io));
    const v4 = o4.ok ? o4.result : { ok: false, reason: o4.reason };
    chk('a fix that passes the probe but breaks the suite is refused: ' + (v4.reason || 'CONFIRMED?!'),
        v4.ok === false && /breaks the project/.test(v4.reason || ''));

    // A probe may only ADD. Overwriting an existing test would let an agent replace a check that disagrees.
    const overwrite = { ...withProbe, probe: { file: 'test/sum.test.mjs', content: GOOD_PROBE } };
    const o5 = await withFindingIo(repo, (io) => verifyFinding(overwrite, io));
    const v5 = o5.ok ? o5.result : { ok: false, reason: o5.reason };
    chk('a probe may not overwrite an existing test: ' + (v5.reason || 'CONFIRMED?!'),
        v5.ok === false && /already exists/.test(v5.reason || ''));

    // And the repo is left as it was found: no probe file survives any of the above.
    chk('  and no probe file was left behind in the source repo',
        !existsSync(join(repo, 'test', 'probe-sum.test.mjs')) && !existsSync(join(repo, 'test', 'probe-proxy.test.mjs')));
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// Shape refusals, which need no repo at all.
{
  const base = { claim: 'x is wrong', class: 'y', where: 'a.mjs:1', fix: { file: 'a.mjs', find: 'p', replace: 'q' } };
  const bad = (probe) => normalizeFinding({ ...base, probe });
  chk('a probe outside test/ is refused', bad({ file: 'src/sneaky.mjs', content: 'x'.repeat(50) }).ok === false);
  chk('a probe not named like a test is refused', bad({ file: 'test/notatest.mjs', content: 'x'.repeat(50) }).ok === false);
  chk('an empty probe is refused', bad({ file: 'test/p.test.mjs', content: '  ' }).ok === false);
  // The control: a well-formed probe passes shape validation, or the three above prove only that everything fails.
  const good = bad({ file: 'test/p.test.mjs', content: 'import { a } from "../a.mjs";' + String.fromCharCode(10) + 'if (a() !== 1) process.exit(1);' });
  chk('  while a well-formed probe is accepted' + (good.ok ? '' : ' — got: ' + good.reason), good.ok === true);
  chk('  and it derives its own check', good.ok && good.finding.check === 'node --test test/p.test.mjs');
}
// A SACRIFICIAL repository, named by GIT_DIR, that has to come through untouched.
//
// test/units.test.mjs proves every file that spawns git mentions gitSafeEnv. That is a source-text property and
// it cannot tell whether the scrub actually holds. This runs the exact builder that did the damage — init,
// config user.*, add, commit — with GIT_DIR pointed at a real repository, and asserts that repository is
// byte-identical afterwards. Unscrubbed, makeRepo() writes `gate@example.invalid` into it and `git init`
// re-inits it as bare, which is precisely what was found in the operator's own .git/config.
//
// The victim is disposable by construction. Nothing here can name the real repository, which is the only
// responsible way to exercise a defect whose failure mode is corrupting the repository you are standing in.
{
  const victim = mkdtempSync(join(tmpdir(), 'bureau-gate-victim-'));
  git(victim, 'init', '-q');
  const victimCfg = join(victim, '.git', 'config');
  const before = readFileSync(victimCfg, 'utf8');
  const restore = process.env.GIT_DIR;
  let built = '', buildErr = '';
  try {
    process.env.GIT_DIR = join(victim, '.git');
    // Caught, not propagated. Unscrubbed, this THROWS rather than returning: `git init` re-inits GIT_DIR as
    // bare, so the fixture's own `git add -A` dies with "must be run in a work tree" — the identical message
    // the pre-push run produced. A crashing suite says less than a failing assertion, and this block is the
    // one that has to explain the defect, so the throw is turned into a red line with the reason on it.
    try { built = makeRepo(); } catch (e) { buildErr = String((e && e.message) || e).split(String.fromCharCode(10))[0].slice(0, 140); }
  } finally {
    if (restore === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = restore;
  }
  chk('a fixture still builds while GIT_DIR names another repository' + (buildErr ? ' — ' + buildErr : ''),
      built !== '' && existsSync(join(built, '.git')));
  // ...and the commit landed in the FIXTURE. Without this, a builder that silently did nothing would pass.
  chk('  and the fixture is the repo that got the commit',
      built !== '' && git(built, 'log', '--format=%s').toString().includes('fixture with a failing test'));
  if (built) rmSync(built, { recursive: true, force: true });
  const after = readFileSync(victimCfg, 'utf8');
  chk('  and the repository named by GIT_DIR is byte-identical afterwards', after === before);
  // The two specific corruptions, named, because "identical" alone would not say which failure was avoided.
  chk('  no fixture identity was written into it', !after.includes('gate@example.invalid'));
  chk('  and it was not re-inited as bare', !/bare = true/.test(after));
  rmSync(victim, { recursive: true, force: true });

  // CONTROL: the assertions above must be able to FAIL, or they measure nothing. Same shape, second victim,
  // and one raw execFileSync that inherits the environment — exactly what every call site did before
  // tools/git-env.mjs existed. The write is expected to LAND on the victim, and if it no longer does then the
  // mechanism has changed and the four assertions above have quietly stopped being about anything.
  const control = mkdtempSync(join(tmpdir(), 'bureau-gate-control-'));
  git(control, 'init', '-q');
  const controlCfg = join(control, '.git', 'config');
  const wasControl = readFileSync(controlCfg, 'utf8');
  const restoreControl = process.env.GIT_DIR;
  const scratch = mkdtempSync(join(tmpdir(), 'bureau-gate-scratch-'));
  try {
    process.env.GIT_DIR = join(control, '.git');
    execFileSync('git', ['config', 'user.email', 'zzz@example.invalid'], { cwd: scratch, stdio: 'pipe' });
  } catch { /* the write reaching the victim is the point; a refusal is reported by the assertion below */ }
  finally {
    if (restoreControl === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = restoreControl;
    rmSync(scratch, { recursive: true, force: true });
  }
  chk('  CONTROL: unscrubbed, that write DOES reach the repository named by GIT_DIR',
      readFileSync(controlCfg, 'utf8').includes('zzz@example.invalid'));
  rmSync(control, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES ✗"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
