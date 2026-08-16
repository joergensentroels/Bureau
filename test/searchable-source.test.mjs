// Every source file must be searchable to the end.
//
// WHY THIS EXISTS — the incident was in Latch, and this repo is the sibling that shares its habits.
// Latch's server.js built an MCP fingerprint key as `${server.name}<NUL>${name}` with the NUL written as a
// RAW BYTE. Choosing NUL as the separator is right: it is the one character that cannot occur in either
// half, so the two cannot be made to collide. Writing it raw rather than escaped is what caused the
// damage, because ripgrep treats any file containing a NUL as binary and stops searching there:
//
//   - a recursive search over that repo read server.js to line 6883 and no further,
//   - the last 238 lines — four functions among them — could not be found by any grep,
//   - and it surfaced as a WARNING on stderr, not an error, so the result looked complete.
//
// That is why this is a gate rather than a note. A search that finds nothing and a search that was never
// allowed to look return the same thing. The audit that concluded a helper there had "zero callers" ran
// greps over that file; it was right, but a caller in the hidden tail would have been invisible to it, so
// the conclusion was luck rather than evidence. Bureau has no such byte today — this keeps it that way,
// and server.mjs is the file with the most to lose, being ~7,000 lines that every audit greps.
//
// Checked on raw bytes rather than by asking ripgrep, so the gate holds wherever the suite runs and does
// not depend on rg being installed. On this machine rg is not even a binary — it is a shell function the
// tooling injects — so no spawned process can reach it.
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { gitSafeEnv } from "../tools/git-env.mjs";

let pass = 0, fail = 0;
const chk = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("✓ " + name + (extra ? "   " + extra : "")); }
  else { fail++; console.log("✗ " + name + (extra ? "   " + extra : "")); }
  return cond;
};

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NUL = 0x00;

// Text formats only. This repo carries ~480 PNGs, which are entitled to contain NULs and which nobody
// greps for a function definition. Matched on extension rather than by sniffing content, because "does
// this look binary" is exactly the judgement that goes wrong here.
const TEXT = new Set([".mjs", ".js", ".cjs", ".json", ".md", ".html", ".css", ".txt",
                      ".yml", ".yaml", ".ps1", ".sh", ".sql", ".toml", ".ini", ".xml", ".svg"]);

// ASK GIT what this repository's source is, rather than walking the directory and hoping a skip list keeps
// runtime state out. Tracked files plus untracked ones git would track (--others --exclude-standard), so a
// source file written a minute ago is still checked while everything .gitignore covers is not.
//
// The walk this replaces enumerated 458 text files here and 54 in a fresh checkout of the same commit, and
// the floor below was set at >100 — so it passed on this machine ONLY, and failed in CI and in every clean
// clone. Both numbers measured 2026-08-16. The gap was not drafts/ being large; it was that the skip list
// matched directory names EXACTLY while the runtime ones are `drafts-hunt-enforcement-<hex>` — about 120 of
// them, none matching "drafts". So the instrument was reading ~400 files its own comment declared out of
// bounds, and the floor was being cleared by exactly those files. It is git that knows which paths are
// state and which are source, and it does not need a second list kept by hand to say so.
//
// Environment-independent by construction: this returns the same set in a fresh clone, in CI and here.
const listed = (() => {
  const out = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"],
                           { encoding: "utf8", env: gitSafeEnv(), maxBuffer: 8e6 });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
})();
const files = listed.filter((rel) => TEXT.has(path.extname(rel).toLowerCase()))
                    .map((rel) => path.join(ROOT, rel));

// A non-vacuity floor. Without it, a listing that silently returned nothing would report "no file contains
// a NUL" — the emptiest possible pass, and the exact shape this repo's notes catalogue repeatedly. Set well
// under the 56 this commit actually carries, because the number it has to survive is a real deletion, not a
// change of machine: a floor that tracks the true count would fail the next time a file is removed, and a
// floor calibrated to one directory's contents is what put this suite in CI-red to begin with.
chk("git named source files to check", files.length > 40, `${files.length} text files`);
chk("  and reached server.mjs, the file every audit greps",
    files.some((f) => path.basename(f) === "server.mjs"));

const offenders = [];
for (const full of files) {
  const buf = await readFile(full).catch(() => null);
  if (!buf) continue;
  const at = buf.indexOf(NUL);
  if (at === -1) continue;
  const line = buf.subarray(0, at).toString("utf8").split("\n").length;
  const total = buf.toString("utf8").split("\n").length;
  offenders.push({ rel: path.relative(ROOT, full), line, hidden: total - line });
}

chk("no source file contains a raw NUL byte", offenders.length === 0);
for (const o of offenders) {
  console.log(`    ${o.rel}: raw NUL at line ${o.line} — hides the ${o.hidden} lines after it from every search`);
  console.log(`    Write it as a six-character \\u0000 escape instead. The runtime value is identical, so`);
  console.log(`    anything already keyed on the old form still matches.`);
}

// ── The detector's own controls ──────────────────────────────────────────────────────────────────────
// "All clear" and "never ran" are the same sentence. These hand the detector bytes that ARE bad and
// require it to say so, in memory rather than on disk — an instrument that writes a probe file into this
// repo trips its own cleanliness test, which has happened here before.
const bad = Buffer.concat([Buffer.from("export const a = 1;\n", "utf8"),
                           Buffer.from([NUL]),
                           Buffer.from("\nexport const b = 2;\n", "utf8")]);
chk("CONTROL: the detector finds a NUL in bytes that have one", bad.indexOf(NUL) !== -1);
chk("CONTROL: and reports the line it sits on",
    bad.subarray(0, bad.indexOf(NUL)).toString("utf8").split("\n").length === 2);
chk("CONTROL: and finds none in bytes that have none",
    Buffer.from("export const a = 1;\nexport const b = 2;\n", "utf8").indexOf(NUL) === -1);

// CONTROL: the extension filter must not be what is doing the work. If TEXT ever stopped matching .mjs,
// every check above would pass while examining nothing that matters.
chk("CONTROL: the extension filter accepts .mjs and rejects .png",
    TEXT.has(".mjs") && !TEXT.has(".png"));

console.log(fail ? `\nFAILURES ✗ — ${pass} passed, ${fail} failed`
                 : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
