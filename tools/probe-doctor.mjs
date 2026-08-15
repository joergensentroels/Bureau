// probe-doctor — is the finding gate's worktree usable, and is a defect actually provable in it?
//
// The finding gate proves a claim by building a throwaway git worktree of guardrails.findingRepo and running a
// check command in it. Two assumptions sit underneath every verdict it produces, and neither is normally tested:
//
//   1. The worktree is USABLE. If the project's own suite is red there for reasons unrelated to the finding, the
//      damage is quiet rather than loud: verifyFinding only applies its "does this fix break the existing suite"
//      guard when the suite was GREEN to begin with, so a red-before worktree switches that safety net off and
//      the gate keeps reporting confirmations without it.
//
//   2. The defect is PROVABLE. Measuring an agent against a planted defect assumes a round could have found it. If
//      no check can fail-then-pass on that defect, every "the round found nothing" says nothing about the agent.
//
// Both were assumed for a whole sequence of measurements here before either was checked. When they finally were:
// assumption 1 held (suite green), and so did 2 — but a model had spent a round insisting the opposite, claiming
// its finding could not be proved because "the module import requires queries.mjs which isn't available in the
// test environment". queries.mjs was right there and imported fine. A blocker reported by the thing whose work
// was just refused is a claim, not a fact.
//
// Usage:
//   node tools/probe-doctor.mjs <repo>
//   node tools/probe-doctor.mjs <repo> --prove <spec.json>
//
// The --prove spec, which describes a defect you believe is detectable:
//   {
//     "check":  "test/min.test.mjs",              // written into the worktree, run with node --test
//     "source": "import { test } from ...",       // the check's content
//     "patch":  { "file": "src/roster.mjs",
//                 "from": "min: 0,",              // must appear EXACTLY once
//                 "to":   "min: Math.min(...counts)," }
//   }
// A spec is only meaningful if the check FAILS before the patch and PASSES after. Anything else is reported as
// not-provable rather than as a pass.
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, symlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gitSafeEnv } from "./git-env.mjs";

const run = promisify(execFile);
// env last and scrubbed through gitSafeEnv, so a caller may still supply one but cannot supply an inherited
// GIT_DIR — this tool is handed the repository to inspect as an argument and must never be told a different
// one by the environment. See tools/git-env.mjs.
const sh = async (cmd, args, opts = {}) => {
  try { const r = await run(cmd, args, { timeout: 300000, maxBuffer: 8e6, ...opts, env: gitSafeEnv(opts.env) }); return { ok: true, out: String(r.stdout || "") + String(r.stderr || "") }; }
  catch (e) { return { ok: false, out: String(e.stdout || "") + String(e.stderr || "") || String(e.message || "") }; }
};

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "   " + extra : ""}`);
  return cond;
};
const note = (s) => console.log("  " + s);

const repo = process.argv[2];
if (!repo) {
  console.log("usage: node tools/probe-doctor.mjs <repo> [--prove <spec.json>]");
  process.exit(2);
}
const proveAt = process.argv.indexOf("--prove");
const specPath = proveAt > 0 ? process.argv[proveAt + 1] : "";

if (!existsSync(path.join(repo, ".git"))) {
  console.log(`✗ ${repo} is not a git repository — the gate builds a worktree from HEAD, so it cannot verify anything here.`);
  process.exit(1);
}

const base = await mkdtemp(path.join(tmpdir(), "probe-doctor-"));
const wt = path.join(base, "wt");

// Labelled, so an early exit still runs the cleanup below. process.exit() inside the try does NOT run finally, and
// the first version used it — leaving a worktree registered in the user's repo every time a precondition failed.
// Found by the suite's "no worktree is left behind" assertion, which looked like housekeeping and was not.
main: try {
  const added = await sh("git", ["-C", repo, "worktree", "add", "-q", "--detach", wt, "HEAD"]);
  if (!ok("a worktree of HEAD can be built", added.ok, added.ok ? "" : added.out.slice(0, 160))) break main;

  // Linked, not copied, exactly as withFindingIo does. Absent is NORMAL for a zero-dependency project and is not
  // scored — an early version of this counted it as a failure and reported a healthy repo as broken.
  const modules = path.join(repo, "node_modules");
  if (existsSync(modules)) {
    try { symlinkSync(modules, path.join(wt, "node_modules"), process.platform === "win32" ? "junction" : "dir"); } catch {}
    ok("node_modules linked into the worktree", existsSync(path.join(wt, "node_modules")));
  } else {
    note("node_modules: none in the repo (nothing to link — normal for a project with no dependencies)");
  }

  // The suite as the gate will find it. This is the one that quietly disables a safety net when it is red.
  const pkg = path.join(wt, "package.json");
  if (existsSync(pkg)) {
    const scripts = JSON.parse(await readFile(pkg, "utf8")).scripts || {};
    if (scripts.test) {
      const suite = await sh("npm", ["test"], { cwd: wt, shell: true });
      if (!ok("the project's own suite is GREEN in a fresh worktree", suite.ok)) {
        note("This is the quiet failure, not the loud one: verifyFinding only applies its \"does this fix break the");
        note("existing suite\" guard when the suite was green to begin with. Red here means findings are still");
        note("confirmed, with that check switched off. Last lines:");
        for (const l of suite.out.trim().split("\n").slice(-6)) note("    " + l);
      }
    } else note("package.json has no test script — the gate can only run checks you name explicitly");
  } else note("no package.json — the gate can only run checks you name explicitly");

  if (specPath) {
    const spec = JSON.parse(await readFile(specPath, "utf8"));
    const target = path.join(wt, spec.patch.file);
    const before = await readFile(target, "utf8");
    const hits = before.split(spec.patch.from).length - 1;
    // An anchor matching zero or many times means the patch is not the edit you think it is. Reported rather than
    // applied: a control that silently patches the wrong place proves nothing about the right one.
    if (!ok(`the patch anchor appears exactly once in ${spec.patch.file}`, hits === 1, `(matched ${hits}x)`)) break main;

    const checkPath = path.join(wt, spec.check);
    await mkdir(path.dirname(checkPath), { recursive: true });
    await writeFile(checkPath, spec.source, "utf8");
    const runCheck = () => sh(process.execPath, ["--test", "--test-reporter=spec", spec.check], { cwd: wt });

    const pre = await runCheck();
    ok("the check FAILS against the code as it is", !pre.ok,
       pre.ok ? "— it passes, so it does not detect the defect and proves nothing" : "");
    if (!pre.ok) note("A check that passes before the fix is the emptiest probe there is.");

    await writeFile(target, before.replace(spec.patch.from, spec.patch.to), "utf8");
    const post = await runCheck();
    ok("and PASSES once the fix is applied", post.ok,
       post.ok ? "" : "— the fix does not satisfy the check, so this pair is not a proof");
    if (!post.ok) for (const l of post.out.trim().split("\n").slice(-4)) note("    " + l);

    // The check must not be removed from the worktree before the suite runs. An earlier version of this left its
    // probe file in place and tripped the repo's own cleanliness test, then reported "the suite fails in a fresh
    // worktree" — the instrument contaminating exactly what it was measuring.
    await rm(checkPath, { force: true });
    const pkg2 = existsSync(pkg) ? JSON.parse(await readFile(pkg, "utf8")).scripts || {} : {};
    if (pkg2.test) {
      const after = await sh("npm", ["test"], { cwd: wt, shell: true });
      ok("and the fix leaves the existing suite green", after.ok);
      if (!after.ok) for (const l of after.out.trim().split("\n").slice(-4)) note("    " + l);
    }
  }
} finally {
  await sh("git", ["-C", repo, "worktree", "remove", "--force", wt]);
  await rm(base, { recursive: true, force: true }).catch(() => {});
  await sh("git", ["-C", repo, "worktree", "prune"]);
}

console.log("");
console.log(fails
  ? `${fails} check(s) failed — do not read a gate verdict from this repo as meaning what it says.`
  : specPath
    ? "Every check passed. The worktree is usable AND the defect is provable in it, so a round that fails to find it has failed at the task rather than at the setup."
    : "Every check passed. The worktree is usable, so the gate's verdicts are about the findings rather than about the environment.");
process.exit(fails ? 1 : 0);
