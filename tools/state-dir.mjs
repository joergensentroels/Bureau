// WHERE BUREAU'S MUTABLE STATE LIVES. One definition, imported by everything that touches it.
//
// Bureau writes its database, its per-workspace org blobs, the workspace registry, the drafts trees and
// the agent-profile trees into its own source directory. That works on bare metal and makes the repo
// unpackageable: a container cannot have an immutable root filesystem while the process must write into
// the directory holding its code, and a named volume cannot persist state that lives interleaved with
// source. It also means a compromised Bureau can rewrite its own source, which Latch's container
// deliberately prevents for itself.
//
// THE DEFAULT IS THE REPO ROOT, and that is the whole safety property of this change. With
// BUREAU_STATE_DIR unset, every path resolves exactly where it resolved before -- byte-identical, no
// migration, no move, nothing for an existing install to do. The container sets the variable; bare metal
// never notices this file exists.
//
// Callers pass their own repo root because they compute it differently (server.mjs from its own URL,
// tools/ from one directory up). Passing it in keeps that difference at the call site instead of
// encoding a guess about layout here.
//
// A SHARED MODULE rather than the same expression in four files. tools/hunt-log.mjs already imports
// gateNeverRan from server.mjs instead of restating the predicate, for the stated reason that a second
// copy drifts and quietly stops recognising what it exists to recognise. The same argument applies with
// more force here: a tool that resolves the state directory differently from the server does not fail,
// it reads a DIFFERENT DATABASE -- and reports confidently about it. tools/hunt-log.mjs looking at an
// empty file while the server writes audit rows elsewhere is exactly the "nothing has happened" reading
// that this repo has already been burned by twice.
import path from "node:path";

export function stateDir(repoRoot, env = process.env) {
  const v = String(env.BUREAU_STATE_DIR || "").trim();
  // Resolved, not joined: an absolute path must be honoured as given, and a relative one is resolved
  // against the process cwd rather than silently against the repo -- a scheduled task and a shell have
  // different cwds, and "state went missing after a reboot" is the failure that hides behind that.
  return v ? path.resolve(v) : repoRoot;
}

// For the boot line. Reporting "same as the repo" versus a real path is the difference between a
// deployment that believes state is on a volume and one that is quietly filling the container layer.
export function stateDirIsOverridden(env = process.env) {
  return Boolean(String(env.BUREAU_STATE_DIR || "").trim());
}
