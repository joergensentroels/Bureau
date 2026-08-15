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
// KNOWN LIMIT, stated because a gate that is over-trusted is worse than one that is read: `accounted()`
// is a SUBSTRING match over the concatenated test sources and TESTING.md. It cannot produce a false
// FAILURE — a symbol nobody mentions anywhere is genuinely unaccounted — but it can be satisfied by a
// coincidental mention, so a short or common export name is weakly checked. It answers "did anyone
// account for this name", not "is this function exercised". That is why the ledger's transitive-coverage
// entries carry mutation evidence instead of just a pointer.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const server = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
const tests = readdirSync(HERE).filter((f) => f.endsWith(".mjs") && f !== "coverage-audit.mjs" && f !== "run-all.mjs")
  .map((f) => readFileSync(path.join(HERE, f), "utf8")).join("\n");
let ledger = ""; try { ledger = readFileSync(path.join(ROOT, "TESTING.md"), "utf8"); } catch {}
const accounted = (s) => tests.includes(s) || ledger.includes(s);

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
