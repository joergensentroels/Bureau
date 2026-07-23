// Coverage audit (soft nudge, not a hard gate). Lists exported functions and /api + /mcp routes in
// server.mjs that are referenced by NEITHER the test files NOR TESTING.md. TESTING.md is the registry
// of "accounted for" — a symbol there is either tested (and noted) or deliberately manual-only with a
// reason. So a gap here means: not tested AND not documented → decide which, then make it disappear.
//   node test/coverage-audit.mjs
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
