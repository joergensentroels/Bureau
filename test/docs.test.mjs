// The doc-figure checker, and the figures it can settle without running anything.
//
// Two jobs, and the split is the point:
//
//   1. AUDIT THE CHECKER. `run-all.mjs` calls `checkDocFigures()` once, at the end of a real run, and a
//      clean result there is worth exactly as much as the checker's ability to produce a dirty one. Every
//      way it could go quietly blind is exercised here: a wrong figure must be named, a right one must
//      NOT be, an unreadable document must not read as a document with nothing to correct, and a
//      document that carries no claims at all must be reported rather than passing perfectly.
//
//   2. SETTLE WHAT NEEDS NO RUN. Suite counts are a fact about `run-all.mjs`'s own arrays, so a stale
//      "across 7 suites" can be caught in the pure set in milliseconds instead of after the server
//      suites boot. The assertion counts cannot be had that cheaply and are deliberately NOT guessed at
//      here — `run-all.mjs` checks those against its own results, where the number actually exists.
//
// The static half reads `run-all.mjs` as TEXT, which is a proxy assertion, and it is used knowingly: the
// arrays cannot be imported, because importing that module runs the whole test suite. So the parse
// carries its own controls (non-empty, and containing a suite known to be in each list), and the same
// figures are re-checked at runtime by `run-all.mjs` against the suites it really ran — the parse is an
// early warning, not the authority.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDocFigures, compare, extractClaims, selfTestProblems, FIG_KEYS, FIGURE_DOCS, REQUIRED_DOCS } from "./doc-figures.mjs";
import { deriveActionSurface } from "./action-surface.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
};

// The marker is written here by construction rather than as a literal, because this file is itself
// scanned by nothing — but README.md is, and a stray literal marker in prose is how a checker comes to
// count its own documentation as a claim.
const mk = (key, n) => `<!--fig:${key}-->${n}`;

// ---- 1. the checker names a wrong figure, and stays quiet about a right one -----------------------
{
  const src = [{ file: "ROADMAP.md", text: `guarded by a suite (${mk("suites", 18)} suites, ${mk("assertions", "1,707")} assertions)` }];
  ok("a figure the run agrees with produces no complaint",
    compare({ suites: 18, assertions: 1707 }, src).problems.length === 0,
    JSON.stringify(compare({ suites: 18, assertions: 1707 }, src).problems));

  const off = compare({ suites: 19, assertions: 1707 }, src).problems;
  ok("a figure the run DISAGREES with is reported", off.length === 1, JSON.stringify(off));
  ok("  and the complaint names the key, the claim and the real value",
    off[0].includes('"suites"') && off[0].includes("18") && off[0].includes("19"), off[0]);

  ok("a comma in the claimed number is read as one number, not truncated at the comma",
    compare({ assertions: 1707 }, src).problems.length === 0);
  ok("  so a comma'd figure can still be caught wrong",
    compare({ assertions: 1708 }, src).problems.length === 1);
}

// ---- 2. the ways it could go blind ---------------------------------------------------------------
{
  // The empty-parse trap: no claims found must never read the same as all claims correct.
  const empty = [{ file: "ROADMAP.md", text: "no figures here at all" }, { file: "test/README.md", text: mk("suites", 18) }];
  const p = checkDocFigures({ suites: 18 }, empty);
  ok("a REQUIRED doc carrying no claim is reported", p.some((x) => x.includes("ROADMAP.md") && x.includes("no <!--fig")), JSON.stringify(p));

  const unread = [{ file: "ROADMAP.md", text: "" }, { file: "test/README.md", text: mk("suites", 18) }];
  ok("an unreadable/empty document is reported, not treated as a clean one",
    checkDocFigures({ suites: 18 }, unread).some((x) => x.includes("unreadable")), "");

  const missingReq = [{ file: "README.md", text: mk("suites", 18) }];
  ok("a required document that was never scanned is reported",
    checkDocFigures({ suites: 18 }, missingReq).some((x) => x.includes("required list")));

  const noClaim = [{ file: "ROADMAP.md", text: mk("suites", 18) }, { file: "test/README.md", text: mk("suites", 18) }];
  ok("an observed figure that NOTHING in the docs claims is reported",
    checkDocFigures({ suites: 18, assertions: 1707 }, noClaim).some((x) => x.includes('"assertions"')));

  ok("a mistyped marker key is reported rather than silently ignored",
    compare({}, [{ file: "x.md", text: mk("assertion", 5) }]).problems.some((x) => x.includes("not a known figure key")));

  const disagree = [{ file: "a.md", text: mk("suites", 18) }, { file: "b.md", text: mk("suites", 12) }];
  ok("two documents claiming different values for one key disagree loudly",
    compare({}, disagree).problems.some((x) => x.includes("18") && x.includes("12")),
    JSON.stringify(compare({}, disagree).problems));
}

// ---- 3. the self-test is the control, so the control needs a control -------------------------------
{
  const good = [{ file: "ROADMAP.md", text: mk("suites", 18) }];
  ok("selfTest is quiet when the checker CAN discriminate", selfTestProblems({ suites: 18 }, good).length === 0);
  // A source set with nothing to compare against is exactly the state in which every comparison passes.
  ok("selfTest fires when there is no claim to discriminate against",
    selfTestProblems({ suites: 18 }, [{ file: "ROADMAP.md", text: "prose only" }]).length === 1);
  ok("  and it says the clean result means nothing",
    selfTestProblems({ suites: 18 }, [{ file: "ROADMAP.md", text: "prose only" }])[0].includes("would mean nothing"));
  // The control's own trap: perturbing by +1 onto a value the document ALREADY claims tests nothing, and
  // reports a working checker as blind. Docs claiming 20 while a run produces 19 is exactly that shape.
  ok("the self-test does not perturb onto a value the doc already claims",
    selfTestProblems({ suites: 19 }, [{ file: "ROADMAP.md", text: mk("suites", 20) }]).length === 0,
    JSON.stringify(selfTestProblems({ suites: 19 }, [{ file: "ROADMAP.md", text: mk("suites", 20) }])));
}

// ---- 4. the marker survives being written the way a document writes it -----------------------------
{
  const bolded = `**${mk("assertions", "1,707")} headless assertions**`;
  ok("a marker immediately before a bold number is still read", extractClaims(bolded)[0]?.value === 1707, JSON.stringify(extractClaims(bolded)));
  ok("a marker followed by prose before its number is NOT read as a claim",
    extractClaims(`<!--fig:suites-->about eighteen`).length === 0);
  ok("every declared key is spelled the way the extractor matches",
    FIG_KEYS.every((k) => extractClaims(mk(k, 3))[0]?.key === k), FIG_KEYS.join(","));
}

// ---- 5. the suite counts, derived from run-all.mjs and checked against the docs --------------------
{
  const runAll = readFileSync(join(HERE, "run-all.mjs"), "utf8");
  const arr = (name) => {
    const m = runAll.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  };
  const PURE = arr("PURE"), SERVER = arr("SERVER");

  // Controls on the parse itself. An array that came back empty would make every count below 0 and the
  // comparison would fail loudly rather than pass — but it would fail for the wrong reason, and a wrong
  // reason costs an investigation. These say plainly which it is.
  ok("parsed the PURE suite list out of run-all.mjs", PURE.length > 0, `${PURE.length} entries`);
  ok("parsed the SERVER suite list out of run-all.mjs", SERVER.length > 0, `${SERVER.length} entries`);
  ok("  the PURE parse really is the pure list (units is in it)", PURE.includes("units.test.mjs"), PURE.join(","));
  ok("  the SERVER parse really is the server list (api is in it)", SERVER.includes("api.test.mjs"), SERVER.join(","));
  ok("  and the two lists are disjoint", !PURE.some((f) => SERVER.includes(f)));
  ok("  this suite is registered in one of them", [...PURE, ...SERVER].includes("docs.test.mjs"),
    "an unregistered doc checker is a doc checker nothing runs");

  // The suite LIST, not just its size. This README once described nine suites and omitted fourteen,
  // which no count would have caught — the totals were stale in the same commit, but a corrected total
  // over a wrong list is still a wrong list. Both directions: a suite the runner runs must be described,
  // and a suite the README describes must still exist.
  const LIVE = arr("LIVE");
  const readme = readFileSync(join(HERE, "README.md"), "utf8");
  const missing = [...PURE, ...SERVER].filter((f) => !readme.includes(f));
  ok("every suite run-all.mjs runs is named in test/README.md", missing.length === 0, missing.join(", "));
  const known = new Set([...PURE, ...SERVER, ...LIVE]);
  const phantom = [...new Set([...readme.matchAll(/\b([a-z0-9-]+\.(?:test\.)?mjs)\b/g)].map((m) => m[1]))]
    .filter((f) => f.endsWith(".test.mjs") && !known.has(f));
  ok("test/README.md names no suite that no longer exists", phantom.length === 0, phantom.join(", "));
  ok("  the LIVE list parsed too, so the e2e is not counted as a phantom", LIVE.length > 0, LIVE.join(","));

  const sources = FIGURE_DOCS.map((f) => {
    try { return { file: f, text: readFileSync(join(ROOT, f), "utf8") }; } catch { return { file: f, text: "" }; }
  });
  // The action-surface counts belong in this half rather than in run-all.mjs's: they are static facts
  // about server.mjs, so they cost a parse and not a run. Derived through action-surface.mjs, NOT by
  // importing action-surface.test.mjs — that file asserts at import time and sets process.exitCode,
  // so importing it here would run its suite and let its verdict overwrite this one's.
  const surface = deriveActionSurface();
  ok("derived the action surface for the figure check",
    surface.reachable.length > 0 && surface.dispatched.length > 0,
    `${surface.reachable.length} reachable, ${surface.dispatched.length} branches`);

  const observed = { suites: PURE.length + SERVER.length, "pure-suites": PURE.length, "server-suites": SERVER.length,
    "reachable-actions": surface.reachable.length, "dispatch-branches": surface.dispatched.length };
  const problems = checkDocFigures(observed, sources);
  ok("the documents' SUITE figures match run-all.mjs's own lists", problems.length === 0, problems.join(" | "));

  // The floor, per the same argument the checker makes about itself: this assertion is only worth
  // something if the documents were actually read and actually carry claims.
  const claims = sources.flatMap((s) => extractClaims(s.text));
  ok("the documents were read and do carry figure claims", claims.length >= 6, `${claims.length} claims across ${sources.length} docs`);
  for (const req of REQUIRED_DOCS) {
    const s = sources.find((x) => x.file === req);
    ok(`  ${req} carries at least one`, !!s && extractClaims(s.text).length > 0);
  }
  ok("every key the docs claim is a key this project knows",
    claims.every((c) => FIG_KEYS.includes(c.key)), [...new Set(claims.map((c) => c.key))].join(","));
}

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
