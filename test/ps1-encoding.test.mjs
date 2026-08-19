// A non-ASCII character in a live PowerShell string breaks the file, silently, on this machine.
//
// Every .ps1 here is UTF-8 WITHOUT a byte-order mark. Windows PowerShell 5.1 -- the one that actually
// runs them, via powershell.exe in the scheduled tasks and in the operator's own elevated window --
// has no BOM to go on and decodes such a file as CP1252. An em dash (E2 80 94) therefore arrives as
// three characters, the last being U+201D, RIGHT DOUBLE QUOTATION MARK, which PowerShell accepts as a
// closing quote. One em dash inside a double-quoted string ends that string early and everything after
// it in the file tokenises as garbage.
//
// THIS REPOSITORY ALREADY KNEW THAT. Install-Heartbeat.ps1 carries a header note saying exactly it,
// in prose, near the top of the file. On 2026-08-19 the identical mistake was made anyway, in
// Install-Latch-S4UStartupTask.ps1 in the sibling repo: one em dash added to a Write-Host string
// turned a working installer into two parse errors, reported 13 and 26 lines below the real fault, in
// the file that registers Latch's startup task. Knowledge written down in one file does not travel to
// the next file, and it does not survive the moment someone is thinking about something else. That is
// the entire argument for this being a test rather than another paragraph.
//
// WHY THIS IS NOT A POWERSHELL PARSE CHECK. The obvious instrument -- run the PowerShell parser over
// every .ps1 -- is blind to this bug in most places it would run. CI runners have pwsh 7, which assumes
// UTF-8 and decodes these files correctly, so it parses clean exactly where 5.1 chokes. A probe that
// fails only on the developer's machine and passes in CI is worse than none. This reads the BYTES,
// which say the same thing everywhere.
//
// Comments stay inert on purpose: these files carry em dashes in their prose throughout, deliberately,
// and a check that flagged those would be noise and would get switched off.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipDirs = new Set([".git", "data", "data-dev", "node_modules", "__pycache__", "bureauProjects"]);

// Walk the source tracking what PowerShell would consider itself inside, and report only characters
// reached in CODE or STRING state. Comment state is inert by construction.
export function liveNonAscii(text) {
  const hits = [];
  let i = 0, line = 1;
  let block = 0;      // <# #> nesting depth
  let quote = null;   // the open ' or " delimiter
  let here = null;    // '"@' or "'@" while inside a here-string
  while (i < text.length) {
    const c = text[i], c2 = text[i + 1];
    if (c === "\n") { line++; i++; continue; }

    if (here) {
      // A here-string ends only at "@ or '@ at the start of a line, so a bare quote inside is data.
      if ((i === 0 || text[i - 1] === "\n") && text.startsWith(here, i)) { here = null; i += 2; continue; }
      if (c.charCodeAt(0) > 127) hits.push({ line, ch: c, where: "here-string" });
      i++; continue;
    }
    if (block > 0) {
      if (c === "#" && c2 === ">") { block--; i += 2; continue; }
      if (c === "<" && c2 === "#") { block++; i += 2; continue; }
      i++; continue;
    }
    if (quote) {
      if (quote === '"' && c === "`") { i += 2; continue; }            // backtick escapes the next char
      if (c === quote && text[i + 1] === quote) { i += 2; continue; }  // '' and "" are literal quotes
      if (c === quote) { quote = null; i++; continue; }
      if (c.charCodeAt(0) > 127) hits.push({ line, ch: c, where: "string" });
      i++; continue;
    }
    if (c === "<" && c2 === "#") { block++; i += 2; continue; }
    if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }   // to end of line
    if (c === "@" && (c2 === '"' || c2 === "'")) { here = c2 + "@"; i += 2; continue; }
    if (c === '"' || c === "'") { quote = c; i++; continue; }
    if (c.charCodeAt(0) > 127) hits.push({ line, ch: c, where: "code" });
    i++;
  }
  return hits;
}

// SELF-CHECK FIRST, every run. A scanner that quietly stopped recognising strings would report
// "0 files with live non-ASCII" -- the same sentence it prints when the repository is genuinely clean,
// which is the state it spends nearly all of its life in. Those two are told apart here rather than
// assumed apart. The inert cases matter as much as the dangerous ones: a version that flagged trailing
// comments would be switched off inside a week, and then it would be guarding nothing.
const DASH = String.fromCharCode(0x2014);
const controls = [
  ["em dash in a live double-quoted string", `Write-Host "REGISTERED ${DASH} missing"`, true],
  ["em dash in a single-quoted string",      `$s = 'a ${DASH} b'`,                      true],
  ["accented character in a string",         `$s = "café"`,                        true],
  ["a # inside a string is not a comment",   `Write-Host "a # b ${DASH} c"`,            true],
  ["em dash in a line comment",              `# a note ${DASH} harmless`,               false],
  ["em dash in a <# block #> comment",       `<#\n  note ${DASH} harmless\n#>\n$x = 1`, false],
  ["em dash in a trailing comment",          `$x = 1   # note ${DASH} harmless`,        false],
  ["pure ASCII code",                        `Write-Host "plain - ascii"`,              false],
];
const brokenControls = controls.filter(([, text, shouldFlag]) => (liveNonAscii(text).length > 0) !== shouldFlag);
if (brokenControls.length) {
  console.error("ps1-encoding: the scanner is wrong -- it failed its own controls:");
  for (const [name, , shouldFlag] of brokenControls) {
    console.error(`- ${name}: expected ${shouldFlag ? "FLAGGED" : "ignored"}, got the opposite`);
  }
  console.error("Every result below would be meaningless, so nothing was scanned.");
  process.exit(1);
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) yield* walk(path.join(dir, entry.name));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".ps1")) yield path.join(dir, entry.name);
  }
}

const findings = [];
let scanned = 0;
for await (const file of walk(root)) {
  scanned++;
  const relative = path.relative(root, file).replaceAll("\\", "/");
  for (const hit of liveNonAscii(await readFile(file, "utf8"))) {
    const code = hit.ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    findings.push(`${relative}:${hit.line} U+${code} ${JSON.stringify(hit.ch)} in ${hit.where}`);
  }
}

// Zero files scanned is the other way this passes without looking: a moved directory, a renamed
// extension, a walk that found nothing. That is a failure, not a pass.
if (scanned === 0) {
  console.error("ps1-encoding failed: no .ps1 files found at all. The walk is looking in the wrong place.");
  process.exit(1);
}

if (findings.length) {
  console.error("ps1-encoding failed: non-ASCII where PowerShell 5.1 will tokenise it:");
  for (const finding of findings) console.error(`- ${finding}`);
  console.error("");
  console.error("These files are UTF-8 with no BOM, so 5.1 reads them as CP1252 and an em dash ends with");
  console.error("U+201D, which it treats as a closing quote. Use ASCII in the string, or move the character");
  console.error("into a comment, where it is inert.");
  process.exit(1);
}

// Reported as "N passed, 0 failed" because run-all.mjs's doc-figure check parses that shape out of every
// suite, and a suite it cannot read a count from fails the run. The count is the eight scanner controls
// plus one decision per file, which is what was actually checked.
const assertions = controls.length + scanned;
console.log(`ps1-encoding: ${controls.length} scanner controls held, ${scanned} .ps1 file(s) clean - ${assertions} passed, 0 failed`);
