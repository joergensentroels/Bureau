// The one invariant docker/compose.yaml exists to hold: Bureau gets NO path to Latch's filesystem.
//
// A comment asking people not to add a mount is not a control. The mount is the obvious fix the first
// time someone hits "could not load Latch's operator token" in a container -- it makes the error go away,
// the stack starts, every check passes, and the trust boundary the two-container split was built for is
// gone. Nothing about the running system looks different. That is precisely the shape of regression a
// test has to catch, because review will not: the diff is one plausible line.
//
// TEXT-SCOPED, not YAML-parsed, and deliberately. Bureau has zero runtime dependencies and is not
// acquiring a YAML parser to check one file; the properties asserted here are all statable over lines
// within a service block. The tradeoff is honest -- this cannot understand anchors or flow mappings, so
// it fails loudly if the file stops looking the way it expects rather than quietly asserting nothing
// about a file it no longer understands.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMPOSE = path.join(ROOT, "docker", "compose.yaml");

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) passed++; else { failed++; console.error(`  FAIL  ${what}`); } };

// Split "services:" into per-service blocks by indentation. Returns a Map of name -> array of lines.
// Exported so the controls below run against the same parser the assertions use, rather than a
// simplified stand-in that could agree with a broken implementation.
export function serviceBlocks(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (start < 0) return null;
  const out = new Map();
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l) && l.trim()) break;                  // dedented to a new top-level key
    const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);       // exactly two spaces = a service name
    if (m) { current = m[1]; out.set(current, []); continue; }
    if (current) out.get(current).push(l);
  }
  return out;
}

if (!existsSync(COMPOSE)) {
  // Absence is a failure, not a pass. A renamed or moved compose file must not silently retire the only
  // check standing between this repo and a re-merged trust domain.
  console.error(`compose-boundary failed: ${COMPOSE} does not exist.`);
  console.error("If the stack file moved, point this suite at it — do not delete the check.");
  process.exit(1);
}

const text = readFileSync(COMPOSE, "utf8");
const blocks = serviceBlocks(text);
if (!blocks || !blocks.has("bureau") || !blocks.has("latch")) {
  console.error("compose-boundary failed: could not find both `latch` and `bureau` service blocks.");
  console.error(`Found: ${blocks ? [...blocks.keys()].join(", ") || "(none)" : "no services: key"}`);
  console.error("The file's shape changed. Fix this parser rather than letting it assert nothing.");
  process.exit(1);
}

// COMMENTS ARE NOT CONFIGURATION, and conflating them is how the first version of this suite failed.
// The bureau block carries the line "There is no LATCH_DATA here and there must not be" -- so a naive
// /LATCH_DATA/ over the raw text reports a violation caused by the warning against it. Likewise a port
// pattern of `something:digits` matched `- LATCH_URL=http://latch:8787` out of the environment list.
//
// Both controls below PASSED while both checks were wrong, which is the lesson worth keeping: a control
// proves a check can change its answer, not that it is reading the right text. So the text is narrowed
// first -- comments stripped, and each assertion scoped to the sub-block it is actually about.
const decomment = (lines) => lines
  .filter((l) => !/^\s*#/.test(l))
  .map((l) => l.replace(/\s+#.*$/, ""));

// Extract a nested key's lines from a service block, by indentation. Returns [] when the key is absent,
// which callers must distinguish from "present and empty" where it matters.
function subBlock(blockLines, key) {
  const idx = blockLines.findIndex((l) => new RegExp(`^\\s+${key}:\\s*$`).test(l));
  if (idx < 0) return [];
  const indent = blockLines[idx].match(/^\s*/)[0].length;
  const out = [];
  for (let i = idx + 1; i < blockLines.length; i++) {
    const l = blockLines[i];
    if (!l.trim()) continue;
    if (l.match(/^\s*/)[0].length <= indent) break;
    out.push(l);
  }
  return out;
}

const bureauLines = decomment(blocks.get("bureau"));
const latchLines = decomment(blocks.get("latch"));
const bureau = bureauLines.join("\n");
const latch = latchLines.join("\n");
const bureauEnv = subBlock(bureauLines, "environment").join("\n");
const latchEnv = subBlock(latchLines, "environment").join("\n");

// ---- THE CENTRAL INVARIANT -------------------------------------------------------------------------
ok(!/LATCH_DATA/.test(bureauEnv),
   "bureau must not set LATCH_DATA — that is the variable that points it at Latch's data directory");
ok(!/openclaw-command-center/.test(bureau),
   "bureau must not reference Latch's repo path (a bind mount into the credential boundary)");
ok(/OPERATOR_TOKEN_FILE\s*=\s*\/run\/secrets\//.test(bureauEnv),
   "bureau takes its operator token from a secret file under /run/secrets");
ok(/LATCH_URL\s*=\s*http:\/\/latch:/.test(bureauEnv),
   "bureau reaches Latch over the network by service name, not through the disk");

// No named volume may appear in both services: a shared volume is a shared filesystem, whatever it is
// called. Matches `  - name:/path` lines only, so a commented-out example cannot satisfy or break this.
const vols = (block) => new Set([...block.matchAll(/^\s+-\s+([A-Za-z0-9_.-]+):\//gm)].map((m) => m[1]));
const shared = [...vols(bureau)].filter((v) => vols(latch).has(v));
ok(shared.length === 0, `no named volume may be mounted into both services (shared: ${shared.join(", ")})`);

// ---- publishing posture ----------------------------------------------------------------------------
// A bare "8787:8787" binds 0.0.0.0 and would publish the credential boundary on every interface,
// including the tailnet, without a word in the diff to say so.
// Scoped to each service's `ports:` block. Reading the whole service block matched LATCH_URL out of the
// environment list, which is not a published port and never was.
for (const [name, lines] of [["latch", latchLines], ["bureau", bureauLines]]) {
  const portLines = subBlock(lines, "ports");
  ok(portLines.length > 0, `${name}: has a ports: block for this check to read`);
  const ports = portLines.map((l) => l.replace(/^\s*-\s*/, "").replace(/"/g, "").trim()).filter(Boolean);
  const unbound = ports.filter((p) => !p.startsWith("127.0.0.1:"));
  ok(unbound.length === 0, `${name}: every published port must be bound to 127.0.0.1 (loose: ${unbound.join(", ")})`);
}

// ---- hardening that must not be quietly dropped ----------------------------------------------------
ok(/read_only:\s*true/.test(latch), "latch keeps an immutable root filesystem");
ok(/read_only:\s*true/.test(bureau), "bureau keeps an immutable root filesystem too, now that its state has one home");

// THE MOUNT PATH MUST MATCH THE VARIABLE. If BUREAU_STATE_DIR and the volume's mount point drift apart,
// nothing errors: Bureau writes its database into the container's own layer, the volume sits there empty,
// everything looks healthy, and the next `docker compose up --force-recreate` silently destroys every
// workspace and audit row. Cross-checking the two is the only thing standing between that and a backup.
const stateVar = (bureauEnv.match(/BUREAU_STATE_DIR\s*=\s*(\S+)/) || [])[1] || "";
ok(stateVar !== "", "bureau sets BUREAU_STATE_DIR so its writable state has a single home");
const stateMounts = subBlock(bureauLines, "volumes")
  .map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean)
  .map((v) => v.split(":")[1] || "");
ok(stateMounts.includes(stateVar),
   `a volume must be mounted exactly at BUREAU_STATE_DIR (${stateVar}); mounts: ${stateMounts.join(", ") || "none"}`);
ok(/LATCH_LOG\s*=\s*\/app\/data\//.test(latchEnv),
   "latch's log is redirected into its writable volume — without this, read_only kills it on boot");
ok(/x-hardening:/.test(text) && /<<:\s*\*hardening/.test(bureau) && /<<:\s*\*hardening/.test(latch),
   "both services inherit the shared hardening block (cap_drop, no-new-privileges, pids_limit)");
ok(/cap_drop:/.test(text) && /-\s*ALL/.test(text), "capabilities are dropped wholesale somewhere in the file");
ok(/no-new-privileges:true/.test(text), "no-new-privileges is set");

// ---- controls: can any of this actually fail? ------------------------------------------------------
// Without these, "13 passed" is indistinguishable from a parser that returns empty blocks and regexes
// that match nothing. Each control mutates the real text and asserts the specific check flips.
// Each control runs the mutated text through the SAME chain the assertions use -- serviceBlocks, then
// decomment, then subBlock. A control that reimplements the check in miniature is how the comment-matching
// and LATCH_URL-as-a-port bugs both survived their own controls the first time round.
const ctl = [];
const envOf = (t, svc) => subBlock(decomment(serviceBlocks(t).get(svc)), "environment").join("\n");
const portsOf = (t, svc) => subBlock(decomment(serviceBlocks(t).get(svc)), "ports")
  .map((l) => l.replace(/^\s*-\s*/, "").replace(/"/g, "").trim()).filter(Boolean);

let m = text.replace(/( {2}bureau:\n)/, "$1    environment:\n      - LATCH_DATA=/latch/data\n");
ctl.push(["a planted LATCH_DATA in bureau's environment is caught", /LATCH_DATA/.test(envOf(m, "bureau"))]);

// The inverse control, and the one that actually matters: the real file must NOT trip it. This is what
// distinguishes "the check works" from "the check fires on the prose warning against the thing".
ctl.push(["the real file's LATCH_DATA warning comment does NOT trip it", !/LATCH_DATA/.test(envOf(text, "bureau"))]);

m = text.replace('- "127.0.0.1:8787:8787"', '- "8787:8787"');
ctl.push(["a port published on 0.0.0.0 is caught", portsOf(m, "latch").some((p) => !p.startsWith("127.0.0.1:"))]);
ctl.push(["LATCH_URL is not mistaken for a published port", !portsOf(text, "bureau").some((p) => /LATCH_URL/.test(p))]);

m = text.replace(/read_only:\s*true/, "read_only: false");
ctl.push(["losing latch's read-only rootfs is caught", !/read_only:\s*true/.test(decomment(serviceBlocks(m).get("latch")).join("\n"))]);

// A stripped environment block must read as absent, not as vacuously clean.
ctl.push(["subBlock reports absence rather than inventing content", subBlock(["    other:", "      - x"], "environment").length === 0]);

// A drifted mount point must be caught. This is the silent-data-loss case, so it gets its own control.
m = text.replace("- bureau-state:/app/state", "- bureau-state:/app/elsewhere");
const drifted = subBlock(decomment(serviceBlocks(m).get("bureau")), "volumes")
  .map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean).map((v) => v.split(":")[1] || "");
ctl.push(["a volume mounted somewhere other than BUREAU_STATE_DIR is caught", !drifted.includes(stateVar)]);
ctl.push(["and the real file's mount does match", stateMounts.includes(stateVar)]);

// And the parser must not "find" services in a file that has none.
ctl.push(["the parser reports nothing for a file with no services: key", serviceBlocks("name: x\nvolumes:\n  a:\n") === null]);
ctl.push(["the parser finds both real services", blocks.size >= 2]);

for (const [what, held] of ctl) ok(held, `control: ${what}`);

if (failed) { console.error(`compose-boundary: ${passed} passed, ${failed} failed`); process.exit(1); }
console.log(`compose-boundary: the credential boundary survives the compose file - ${passed} passed, 0 failed`);
