// No credential may be committed to this repository.
//
// WHY BUREAU NEEDS ITS OWN. Latch has had `test/secret-scan.mjs` in its npm test chain for a while, and it
// has fired for real — an agent's fixture tokens reached a tracked log and it caught them. Bureau had no
// equivalent. That asymmetry is the wrong way round: Bureau is public, and its operator token is
// documented in SECURITY.md as equivalent to shell access on this machine. Nothing mechanical stopped one
// being committed; the only guard was noticing.
//
// WHAT IT LOOKS FOR, and why each one:
//   - Provider API keys. Real money and someone else's account.
//   - Latch operator/agent tokens (`op_`, `agent_`). Bureau authenticates against these, so it can hold
//     them in a config, a fixture or a pasted transcript.
//   - Trigger tokens. 32 hex characters from randomUUID; server.mjs calls this "a 122-bit secret that can
//     start runs", and /api/trigger/<token> is the ONE unauthenticated endpoint in the server.
//
// WHAT IT DELIBERATELY DOES NOT DO: match on prefix and length alone. `agent_deleted_yesterday` is a real
// fixture in workspaces.test.mjs and matches Latch's `agent_[A-Za-z0-9_-]{12,}` exactly. A scanner whose
// first run fails on a fixture is a scanner someone switches off, so the patterns below require the
// ENTROPY a generated token has and prose does not: at least one uppercase letter and one digit. That is
// a property of base64url over random bytes, not a guess about naming.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { gitSafeEnv } from "../tools/git-env.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const chk = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("✓ " + name + (extra ? "   " + extra : "")); }
  else { fail++; console.log("✗ " + name + (extra ? "   " + extra : "")); }
  return cond;
};

// Generated-token shape: mixed case AND a digit. Random base64url of 18+ bytes has both with probability
// so close to 1 that the exceptions are not worth a false negative; English identifiers have neither.
const looksGenerated = (s) => /[A-Z]/.test(s) && /[0-9]/.test(s);

const PATTERNS = [
  { name: "provider API key", re: /\b(sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,})\b/g },
  { name: "Latch operator token", re: /\bop_[A-Za-z0-9_-]{20,}\b/g, needsEntropy: true },
  { name: "Latch agent token", re: /\bagent_[A-Za-z0-9_-]{20,}\b/g, needsEntropy: true },
  // Bare 32-hex. Deliberately NOT applied to .md: documentation legitimately cites commit hashes and
  // digests, and a doc citing one is not a leaked credential.
  { name: "trigger token (32 hex)", re: /\b[0-9a-f]{32}\b/g, codeOnly: true },
];

// A machine-specific literal that must never become a tracked pattern goes in a gitignored file, exactly
// as Latch does it — putting the secret in the scanner would be the leak.
const denylist = (() => {
  const f = path.join(ROOT, "data", "secret-scan-denylist.txt");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
})();

const TEXT = new Set([".mjs", ".js", ".cjs", ".json", ".md", ".html", ".css", ".txt", ".yml", ".yaml",
                      ".ps1", ".sh", ".sql", ".toml", ".ini", ".xml", ".svg"]);
const CODE = new Set([".mjs", ".js", ".cjs", ".json", ".html", ".ps1", ".sh", ".yml", ".yaml"]);

// git decides what is source. The alternative — a hand-kept skip list — is what put searchable-source in
// CI-red: its list matched directory names exactly while the runtime dirs carry a suffix.
const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"],
                             { encoding: "utf8", env: gitSafeEnv(), maxBuffer: 8e6 })
  .split("\n").map((l) => l.trim()).filter(Boolean)
  .filter((rel) => TEXT.has(path.extname(rel).toLowerCase()));

chk("git named files to scan", tracked.length > 40, `${tracked.length} text files`);

function scan(text, rel) {
  const ext = path.extname(rel).toLowerCase();
  const hits = [];
  for (const p of PATTERNS) {
    if (p.codeOnly && !CODE.has(ext)) continue;
    for (const m of text.matchAll(p.re)) {
      const value = m[0];
      if (p.needsEntropy && !looksGenerated(value)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      hits.push({ rel, line, name: p.name, value });
    }
  }
  for (const literal of denylist) {
    let i = text.indexOf(literal);
    while (i !== -1) {
      hits.push({ rel, line: text.slice(0, i).split("\n").length, name: "denylisted literal", value: "(redacted)" });
      i = text.indexOf(literal, i + literal.length);
    }
  }
  return hits;
}

const found = [];
for (const rel of tracked) {
  let text = ""; try { text = readFileSync(path.join(ROOT, rel), "utf8"); } catch { continue; }
  found.push(...scan(text, rel));
}

chk("no credential is committed to this repository", found.length === 0);
for (const f of found) {
  // The VALUE is never printed. A scanner that echoes what it found puts the secret into CI logs, the
  // terminal scrollback and any transcript of the run — which is the thing it exists to prevent.
  console.log(`    ${f.rel}:${f.line}  ${f.name}`);
}

// ── controls ─────────────────────────────────────────────────────────────────────────────────────────
// A scanner reporting "clean" and a scanner that matches nothing produce the same output, so these hand
// it strings that ARE secrets and require it to say so — in memory, never written to the tree.
// Every specimen below is ASSEMBLED, never written out. A control for a secret scanner has to be
// secret-shaped, and this file is tracked — so a literal here would be found by the scan above and this
// file would fail on itself. Split across a `+` the pattern never matches the source, only the value.
// (The first draft did write them out, and the run reported three findings, all of them these lines.)
const realOp = "op_" + Buffer.from("Zk3Qx8Lm2Rt7Yv1Nb4Hs6Wd9").toString("base64url");
const fakeKey = "sk-" + "abcdef0123456789" + "ABCDEF";
const fakeHex = "9f8e7d6c5b4a3928" + "1706f5e4d3c2b1a0";
chk("CONTROL: a generated-looking operator token is caught", scan(`const t = "${realOp}";`, "x.mjs").length > 0);
chk("CONTROL: a provider key is caught", scan(`key: "${fakeKey}"`, "x.mjs").length > 0);
chk("CONTROL: a 32-hex trigger token is caught in code", scan(`token: "${fakeHex}"`, "x.mjs").length > 0);
chk("CONTROL: and NOT flagged in a .md, where hashes are legitimately cited",
    scan(`see commit ${fakeHex}`, "x.md").length === 0);
// And the file must not have re-acquired a literal specimen — the assembly above is load-bearing, so it
// gets an assertion rather than a comment asking the next editor to be careful.
chk("CONTROL: this file contains no secret-shaped literal of its own",
    scan(readFileSync(fileURLToPath(import.meta.url), "utf8"), "secret-scan.test.mjs").length === 0);

// The false positive that would have made this useless on day one. It is a REAL string in this repo.
chk("CONTROL: the agent_deleted_yesterday fixture is NOT flagged",
    scan('agentId: "agent_deleted_yesterday"', "x.mjs").length === 0);
chk("CONTROL: nor is ordinary prose that happens to start with a prefix",
    scan('const who = "op_the_operator_decides";', "x.mjs").length === 0);
// ...but the discriminator must still be entropy rather than "contains an underscore".
chk("CONTROL: a generated token WITH underscores is still caught",
    scan(`x = "agent_Ab3${"Cd4Ef5Gh6Ij7Kl8Mn9"}";`, "x.mjs").length > 0);

console.log(fail ? `\nFAILURES ✗ — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
