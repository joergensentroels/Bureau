// First automated coverage for the browser UI. Hermetic: no browser, no server, no network.
//
// Why not Playwright: a real browser suite needs a live Bureau AND a browser dependency, in a repo whose
// zero-dependency property is a stated design feature — and CI has neither. That suite would have to live
// outside both gates like e2e-autonomy, and adding a ~150 MB Chromium download to the clone-and-run story
// is an owner decision, not a test-file decision. So this covers what CAN be checked statically, which
// turns out to include a defect class no browser test would catch reliably either.
//
// 1. SYNTAX. TESTING.md has claimed the inline <script> "is syntax-checked by extracting it and running
//    node --check". Nothing automated it — it was done by hand, once, and the sentence quietly became a
//    claim about a process that did not exist. Now it is true.
//
// 2. SELECTOR INTEGRITY. 2449 lines with ~191 ids and ~45 literal lookups. A misspelled selector in
//    `$("#saveBtn")` throws no error and fails no syntax check: the lookup just returns null and the
//    control is silently dead. That is the single most likely way this UI breaks, and it is exactly what a
//    static check is good at — a browser test only catches it on the paths the test happens to walk.
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "public", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
};

// ---- 1. the inline script parses -------------------------------------------
const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
ok("found the inline <script> block(s)", scripts.length > 0, `${scripts.length} found`);
const dir = mkdtempSync(join(tmpdir(), "bureau-ui-"));
try {
  scripts.forEach((code, i) => {
    const f = join(dir, `inline-${i}.js`);
    writeFileSync(f, code);
    try {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
      ok(`inline script #${i + 1} parses (${code.split("\n").length} lines)`, true);
    } catch (e) {
      ok(`inline script #${i + 1} parses`, false, String(e.stderr || e.message).split("\n").slice(0, 3).join(" | "));
    }
  });
} finally { rmSync(dir, { recursive: true, force: true }); }

// ---- 2. every literal id lookup resolves ----------------------------------
// Defined ids come from anywhere in the file: static markup AND the JS template strings that build rows
// at runtime, plus direct `.id = "x"` assignments. Missing any of those sources would invent failures.
const defined = new Set();
for (const m of HTML.matchAll(/\bid\s*=\s*["']([A-Za-z0-9_-]+)["']/g)) defined.add(m[1]);
for (const m of HTML.matchAll(/\.id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)) defined.add(m[1]);

// Only LITERAL lookups. Composed ones (`$("#row-"+id)`) cannot be checked statically and are skipped by
// construction rather than by an exclusion list that would drift.
const used = new Map();
const patterns = [
  /\$\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/g,
  /getElementById\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g,
  /querySelector\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/g,
];
for (const p of patterns) {
  for (const m of HTML.matchAll(p)) {
    const id = m[1];
    if (!used.has(id)) used.set(id, HTML.slice(0, m.index).split("\n").length);
  }
}

ok("found literal id lookups to check", used.size > 0, `${used.size} distinct`);
const dead = [...used].filter(([id]) => !defined.has(id));
ok(`every literal id lookup resolves to an id that exists (${used.size} checked against ${defined.size} defined)`,
  dead.length === 0,
  dead.map(([id, line]) => `#${id} (line ${line})`).join(", "));

// ---- 3. the controls the signed-out path depends on ------------------------
// These three were the subject of a real UI bug (a signed-out page rendering the first-run wizard over a
// live company) and of a false one (an automated browser throwing on window.prompt, which surfaced as a
// fake "server unreachable"). Pin their existence so a rename cannot quietly remove the sign-in route.
for (const id of ["app", "authWarn"]) ok(`signed-out path still has #${id}`, defined.has(id));
ok("signed-out renderer still exists", /function renderSignedOut\s*\(/.test(HTML));
ok("the sign-in control is shared, not duplicated per call site", (HTML.match(/function signIn\s*\(/g) || []).length === 1);

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
