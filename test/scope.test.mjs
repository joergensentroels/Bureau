// The mechanical scope: which repository paths a run may open at all.
//
// Why it exists, and why it is mechanical rather than a sentence in the prompt. The objective already named the
// 23 changed files and told the round to review THOSE and not the rest of the repository. Measured outcome, one
// round per provider on the same planted defect:
//
//   kimi-k2.6           7 of 16 repo actions inside the named window
//   deepseek-v4-flash   6 of  9 repo actions inside the named window   (Fisher exact p = 0.41 — not a difference)
//   both                0 findings, and NEITHER opened src/roster.mjs, the file holding the defect
//
// Five earlier whole-repository rounds spent 41 of 50 searches inside one file and never opened it either. Asking
// for scope discipline does not produce scope discipline. This suite asserts that the boundary holds when the
// asking fails — and every case here has a control, because a scope that refuses everything would pass a suite
// that only checked that out-of-scope reads are refused.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normScopeFiles, inScope, scopeLine, scopeRefusal, repoReadPlan,
  listRepoFiles, searchRepoFiles, readRepoFile, repoDigest,
} from "../server.mjs";

let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; console.log("✓ " + name); } else { fail++; console.log("✗ " + name); } };
const eq = (name, a, b) => chk(name + "   (got " + JSON.stringify(a) + ")", JSON.stringify(a) === JSON.stringify(b));

console.log("# normScopeFiles — what an operator types becomes what inScope compares");
{
  // A Windows-style entry that stays backslashed matches nothing, and a scope matching nothing denies everything.
  // That fails closed for the wrong reason, which is indistinguishable from working until someone reads a run.
  eq("  backslashes become the separator listRepoFiles actually emits",
     normScopeFiles(["src\\db.mjs"]), ["src/db.mjs"]);
  eq("  leading ./ and / are stripped", normScopeFiles(["./src/a.mjs", "/src/b.mjs"]), ["src/a.mjs", "src/b.mjs"]);
  eq("  a trailing slash is a directory, not a different path", normScopeFiles(["src/"]), ["src"]);
  eq("  duplicates collapse", normScopeFiles(["src/a.mjs", "./src/a.mjs"]), ["src/a.mjs"]);
  eq("  a comma or newline separated string is accepted, because the UI sends one",
     normScopeFiles("src/a.mjs, src/b.mjs\nsrc/c.mjs"), ["src/a.mjs", "src/b.mjs", "src/c.mjs"]);
  eq("  traversal segments are dropped", normScopeFiles(["../etc/passwd", "a/../../b", "."]), []);
  chk("  a/..%2Fb style segment is not mistaken for traversal", normScopeFiles(["a/..b/c.mjs"]).length === 1);
  chk("  the list is capped", normScopeFiles(Array.from({ length: 900 }, (_, i) => "f" + i + ".mjs")).length === 500);
}

console.log("# inScope — segment matching, not string matching");
{
  const one = normScopeFiles(["src/roster.mjs"]);
  chk("  the listed file is in", inScope("src/roster.mjs", one));
  chk("  a sibling is out", !inScope("src/admin.mjs", one));
  // The control that matters. "src" must not admit "srcache/", and "src/roster.mjs" must not admit a longer name
  // that merely starts with it — a plain startsWith would let both through and the scope would leak silently.
  chk("  a longer name that merely starts the same is out", !inScope("src/roster.mjs.bak", one));
  const dir = normScopeFiles(["src"]);
  chk("  a directory entry admits what is under it", inScope("src/roster.mjs", dir));
  chk("  and does NOT admit a sibling directory with the same prefix", !inScope("srcache/x.mjs", dir));
  chk("  nor the bare name of another directory", !inScope("srcs/x.mjs", dir));
  // The inert case. This is the whole reason the feature is safe to ship: unset means unchanged.
  chk("  an empty scope allows everything, exactly as before", inScope("anything/at/all.mjs", []));
  chk("  a null scope allows everything", inScope("anything.mjs", null));
  chk("  a blank path is never in scope", !inScope("", one));
  eq("  and it normalises the path it is given, not just the scope", inScope("src\\roster.mjs", one), true);
}

console.log("# the wording an agent actually receives");
{
  const sc = normScopeFiles(["src/a.mjs", "src/b.mjs"]);
  chk("  no scope means no prompt line at all", scopeLine({ guardrails: { scopeFiles: [] } }) === "");
  const line = scopeLine({ guardrails: { scopeFiles: sc } });
  chk("  a scope says it is ENFORCED, not requested", /refused by the runner/.test(line));
  chk("  and names the paths, so the next turn has somewhere to go", line.includes("src/a.mjs") && line.includes("src/b.mjs"));
  const ref = scopeRefusal("src/secret.mjs", sc);
  chk("  the refusal names what was refused", ref.includes("src/secret.mjs"));
  chk("  says retrying will not help", /asking again will fail again/.test(ref));
  chk("  and lists the scope rather than only saying no", ref.includes("src/a.mjs"));
  const many = normScopeFiles(Array.from({ length: 60 }, (_, i) => "f" + i + ".mjs"));
  chk("  a long scope is truncated with a count, not silently cut", /and 20 more/.test(scopeRefusal("x.mjs", many)));
}

console.log("# the turn loop's own decision — the hole filtering the listing does NOT close");
{
  const scope = normScopeFiles(["src/roster.mjs"]);
  // The agent never has to use a path the listing gave it. It can name one, and `want` goes straight to the
  // filesystem. Every case below is that branch.
  eq("  a resolved target reads (it came from an already-scoped listing)",
     repoReadPlan("src/roster.mjs", "whatever", scope), { kind: "read", path: "src/roster.mjs" });
  eq("  an unresolved path inside the scope still reads",
     repoReadPlan(null, "src/roster.mjs", scope), { kind: "read", path: "src/roster.mjs" });
  eq("  an unresolved path OUTSIDE the scope is refused, not read",
     repoReadPlan(null, "src/admin.mjs", scope), { kind: "refuse", path: "src/admin.mjs" });
  eq("  a blank path still lists", repoReadPlan(null, "", scope), { kind: "list", path: "" });
  // The inert control: with no scope set this branch must behave exactly as it did before the feature existed.
  eq("  with no scope, an unresolved path reads as it always did",
     repoReadPlan(null, "src/admin.mjs", []), { kind: "read", path: "src/admin.mjs" });

  // A tested function nothing calls is the emptiest probe there is, and this project has shipped one: a test that
  // asserted a prompt line was PRESENT while the code threw before reaching it. So assert the wiring, not just
  // the logic — that the runner routes its read through this decision rather than repeating it inline.
  const src = await (await import("node:fs/promises")).readFile(new URL("../server.mjs", import.meta.url), "utf8");
  chk("  and the turn loop actually calls it", /const plan = repoReadPlan\(target, want, scope\)/.test(src));
  chk("  with no second, unrouted read of `want` left behind",
      !/:\s*want\s*\?\s*await readRepoFile\(repo, want\)/.test(src));
}

console.log("# enforcement against a real repository");
{
  const root = await mkdtemp(path.join(tmpdir(), "bureau-scope-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "srcache"), { recursive: true });
  await writeFile(path.join(root, "src", "roster.mjs"), "export const roster = 1;\nconst SECRET_MARKER = 2;\n");
  await writeFile(path.join(root, "src", "admin.mjs"), "export const admin = 1;\nconst SECRET_MARKER = 3;\n");
  await writeFile(path.join(root, "srcache", "cache.mjs"), "const SECRET_MARKER = 4;\n");
  await writeFile(path.join(root, "README.md"), "hello\n");
  const scope = normScopeFiles(["src/roster.mjs"]);

  const wide = await listRepoFiles(root);
  chk("  CONTROL: unscoped, the repository really does contain the other files",
      wide.ok && wide.files.includes("src/admin.mjs") && wide.files.includes("srcache/cache.mjs"));
  chk("  CONTROL: and the file is genuinely readable when unscoped",
      (await readRepoFile(root, "src/admin.mjs")).ok);

  const narrow = await listRepoFiles(root, "", 400, scope);
  eq("  the listing shows only the scope", narrow.files, ["src/roster.mjs"]);
  chk("  and says it was scoped, so an empty-looking repo is explicable", narrow.scoped === true);
  chk("  scoping does not set truncated — that flag means the cap cut the list", narrow.truncated === false);

  // A search reads whole files and reports their lines. An unscoped search is a read of everything by another
  // name, so this is the case a read-only check would have missed entirely.
  const sWide = await searchRepoFiles(root, "SECRET_MARKER");
  chk("  CONTROL: unscoped, the search finds the marker in all three files", sWide.ok && sWide.hits.length === 3);
  const sNarrow = await searchRepoFiles(root, "SECRET_MARKER", "", 60, scope);
  chk("  a whole-repository search only walks the scope", sNarrow.ok && sNarrow.hits.length === 1
      && sNarrow.hits[0].file === "src/roster.mjs");
  const sTarget = await searchRepoFiles(root, "SECRET_MARKER", "src/admin.mjs", 60, scope);
  chk("  and searching a named out-of-scope file is refused, not silently widened",
      !sTarget.ok && sTarget.outOfScope === true);
  chk("  CONTROL: the same targeted search works when that file IS the scope",
      (await searchRepoFiles(root, "SECRET_MARKER", "src/admin.mjs", 60, normScopeFiles(["src/admin.mjs"]))).ok);

  const dWide = await repoDigest(root);
  chk("  CONTROL: unscoped, the map lists every source file", dWide.ok && dWide.entries.length === 3);
  const dNarrow = await repoDigest(root, { scope });
  eq("  the map lists only what can be opened", dNarrow.entries.map((e) => e.file), ["src/roster.mjs"]);

  // A prefix-matching bug would put srcache/cache.mjs inside a "src" scope. Asserted against the filesystem and
  // not only against inScope, because the two normalise paths separately and only one of them was ever tested.
  const dirScope = normScopeFiles(["src"]);
  const dirList = await listRepoFiles(root, "", 400, dirScope);
  eq("  a directory scope admits its files and nothing that merely shares the prefix",
     dirList.files, ["src/admin.mjs", "src/roster.mjs"]);

  await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(fail ? `\nFAILURES ✗ — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
