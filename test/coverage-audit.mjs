// Coverage audit — a GATE. Lists exported functions and /api + /mcp routes in server.mjs that are
// referenced by NEITHER the test files NOR TESTING.md. TESTING.md is the registry of "accounted for" —
// a symbol there is either tested (and noted) or deliberately manual-only with a reason. So a gap here
// means: not tested AND not documented → decide which, then make it disappear.
//   node test/coverage-audit.mjs
//
// It described itself as "a soft nudge, not a hard gate" while TESTING.md listed it as gate item 3 and
// stated the rule "no new export/endpoint ships without a test or a ledger entry". Both could not be
// true. CI ran it as `|| true` and the pre-push hook did not run it at all, so the rule was a sentence
// rather than a mechanism — the exact shape the lens register's own `stale-claim` lens exists to find.
// It is now run for real by `.githooks/pre-push` and by CI, and a gap fails the build.
//
// `accounted()` matches on WORD BOUNDARIES, not substrings. It used to be `tests.includes(s)`, which meant
// an export named `sum` or `emit` was satisfied by `checksum`, `emitted`, or the name buried in an unrelated
// identifier — the gate could be silently satisfied by a coincidence, which matters more now that it blocks
// the build. (This file is excluded from the scanned corpus, so naming symbols here is free. TESTING.md is
// NOT excluded: an example named in its prose really does account for a symbol of that name.)
// The boundary is applied CONDITIONALLY, only on an edge whose own character is a word character:
//   exports   `sum`        -> /\bsum\b/         rejects `checksum`, `summary`, accepts `sum(a, b)`
//   routes    `/api/state` -> /\/api\/state\b/  rejects `/api/statement`, accepts `/api/state?x=1`
// A route gets NO LEADING boundary on purpose. `/relocate` and `/steer` are registered by `.endsWith()`
// and are only ever reached as `/api/run/<id>/steer`, so demanding a delimiter before the `/` would
// report two genuinely-tested routes as gaps. Verified: adding one flips exactly those two to false.
//
// STILL-KNOWN LIMITS, stated because a gate that is over-trusted is worse than one that is read. It
// cannot produce a false FAILURE — a symbol nobody names anywhere is genuinely unaccounted — but it can
// still be satisfied by a mention in a comment, or by an unrelated local of the same name in a test. It
// answers "did anyone account for this name", not "is this function exercised". That is why the ledger's
// transitive-coverage entries carry mutation evidence instead of just a pointer. Two entries in the route
// list (`/api/`, `/mcp`) are router prefixes rather than endpoints and are accounted no matter what.
//
// The matcher carries its own negative control (`selfTest` below) and runs it on every invocation: a
// checker that quietly stopped discriminating would otherwise report the same clean bill of health as one
// that works, and this one reports zero gaps today.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const server = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
const tests = readdirSync(HERE).filter((f) => f.endsWith(".mjs") && f !== "coverage-audit.mjs" && f !== "run-all.mjs")
  .map((f) => readFileSync(path.join(HERE, f), "utf8")).join("\n");
let ledger = ""; try { ledger = readFileSync(path.join(ROOT, "TESTING.md"), "utf8"); } catch {}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const boundedRx = (s) =>
  new RegExp((/^\w/.test(s) ? "\\b" : "") + escapeRegExp(s) + (/\w$/.test(s) ? "\\b" : ""));
const accounted = (s) => { const rx = boundedRx(s); return rx.test(tests) || rx.test(ledger); };

// Negative control, run every time. Derives BOTH halves from the live corpus rather than from an invented
// fixture, so the control cannot drift away from the thing it guards: take a real word that appears in the
// tests or the ledger, then chop its tail. The full word must be accounted (the matcher can say yes) and
// the truncation must not be (the matcher can say no) — even though the truncation is still a literal
// substring of the corpus, which is exactly what the old matcher accepted. A matcher stuck at `true` fails
// the second assertion, one stuck at `false` fails the first, and a substring matcher fails the second.
function selfTest() {
  const corpus = tests + "\n" + ledger;
  const words = [...new Set([...corpus.matchAll(/\b[A-Za-z][A-Za-z0-9]{6,}\b/g)].map((m) => m[0]))].sort();
  const pair = words
    .map((w) => [w, w.slice(0, -2)])
    .find(([, frag]) => corpus.includes(frag) && !new RegExp(`\\b${frag}\\b`).test(corpus));
  if (!pair) return ["control went vacuous: no word in the corpus yields a substring-only fragment"];
  const [word, frag] = pair;
  const bad = [];
  if (!accounted(word)) bad.push(`control: '${word}' occurs in the corpus but accounted() said no`);
  if (accounted(frag)) bad.push(`control: '${frag}' occurs ONLY inside '${word}' but accounted() said yes — matcher is not honouring word boundaries`);
  return bad.length ? bad : null;
}

const controlFailures = selfTest();
if (controlFailures) {
  console.log("Coverage audit — SELF-TEST FAILED, the result below would mean nothing:");
  for (const f of controlFailures) console.log(`    ✗ ${f}`);
  process.exit(1);
}

const exports = [...new Set([...server.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]))];
const routes = new Set();
for (const m of server.matchAll(/"(\/(?:api|mcp)[^"]*)"/g)) routes.add(m[1]);
for (const m of server.matchAll(/\.endsWith\("(\/[^"]+)"\)/g)) routes.add(m[1]);

const fnGaps = exports.filter((e) => !accounted(e));
const routeGaps = [...routes].filter((r) => !accounted(r));

console.log(`Coverage audit — ${exports.length} exported fns, ${routes.size} routes`);
console.log(`  accounted (test or TESTING.md): ${exports.length - fnGaps.length} fns, ${routes.size - routeGaps.length} routes`);
if (fnGaps.length) console.log(`\n  ⚠ exported fns with no test/ledger reference:\n    ${fnGaps.join(", ")}`);
if (routeGaps.length) console.log(`\n  ⚠ routes with no test/ledger reference:\n    ${routeGaps.join(", ")}`);
const gaps = fnGaps.length + routeGaps.length;
console.log(`\n${gaps ? `→ ${gaps} unaccounted symbol(s). Add a test, or note it in TESTING.md with a reason.` : "→ all exported fns + routes are tested or documented ✓"}`);
process.exit(gaps ? 1 : 0);
