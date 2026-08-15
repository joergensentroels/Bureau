// git-env — a spawned process must never inherit the caller's idea of which repository it is in.
//
// Git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends into every hook it runs, and every process
// spawned from there inherits them. Nothing in this repository ever wants that: each place that shells out to
// git names its repository explicitly, with `-C repo` or a cwd, and the fixture builders in the test suites
// create their own throwaway repositories. An inherited GIT_DIR silently retargets all of it at whatever
// repository happened to invoke the hook.
//
// This is not theoretical, and the damage is not a failed test. `git init -q` with GIT_DIR set does not
// initialise the directory it runs in — it re-initialises GIT_DIR, and with no work tree named, as BARE.
// That is how `core.bare = true` reached this repository's own .git/config: the pre-push hook ran the suite,
// the suite built a fixture, and the fixture builder re-inited the repository being pushed. A bare repo
// refuses every work-tree operation — status, diff, commit, push — in the main checkout AND in every linked
// worktree, so the gate could no longer run, so nothing ever reported it. The suites' own fixture identities
// were left behind in [user] as the fingerprint: `gate@example.invalid` from finding-gate.test.mjs and
// `t@example.invalid` from probe-doctor.test.mjs.
//
// .githooks/pre-push unsets these too. That is the belt; this is the braces, and it is the half that still
// holds when someone runs a suite by hand from a shell that happens to have GIT_DIR set — which is both how
// the original damage was done and how it was reproduced.
export const GIT_ENV_VARS = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES",
];

// A COPY of `env` with those removed, shaped for execFile/spawn's `env` option.
//
// A copy rather than a mutation, deliberately: the argument is almost always process.env, and a long-running
// server must not permanently lose variables because it once shelled out to git. The cost is that callers have
// to pass it at the spawn site — which is why test/units.test.mjs derives the set of files that spawn git from
// source and fails when one of them does not route through here.
export function gitSafeEnv(env = process.env) {
  const out = { ...env };
  for (const k of GIT_ENV_VARS) delete out[k];
  return out;
}
