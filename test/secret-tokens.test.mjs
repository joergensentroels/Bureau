// Where Bureau gets its credentials, and what happens when the most-protected source is broken.
//
// This exists because containerising Bureau turns credential provenance into a security property rather
// than a convenience. The three sources are ordered deliberately -- secret file, then environment
// variable, then Latch's auth.json on disk -- and the ordering is only worth anything if the strong
// source cannot silently degrade into a weaker one. A deployment configured with a mounted secret that
// quietly falls back to a bind-mounted auth.json has lost exactly the separation the container split was
// built to create, and it looks identical at runtime to one that is working. So the interesting
// assertions here are the NEGATIVE ones: a named-but-missing secret file must kill the boot, not shrug.
//
// Every case runs in its own child process (test/token-source-probe.mjs) because DATA_DIR is resolved
// from LATCH_DATA at module-load time and cannot be re-pointed after import.
//
// NO TOKEN VALUE IS EVER COMPARED DIRECTLY -- the probe returns eight hex characters of SHA-256, and this
// file hashes its own fixtures the same way. The auth.json fallback reaches the operator's real token on
// a developer machine, and that token is shell access to the host.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, "token-source-probe.mjs");
const digest = (v) => createHash("sha256").update(String(v)).digest("hex").slice(0, 8);

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL  ${what}`); } };

// The child inherits nothing it was not given. Bureau's real credentials live in the ambient
// environment on the operator's own machine, and a case meaning to test "no OPERATOR_TOKEN set" would
// otherwise quietly pick one up and assert nothing. Every variable this suite cares about is stated
// per case, present or absent.
const CONTROLLED = ["OPERATOR_TOKEN", "OPERATOR_TOKEN_FILE", "BUREAU_READ_TOKEN", "BUREAU_READ_TOKEN_FILE", "LATCH_DATA"];
function probe(env) {
  const childEnv = { ...process.env };
  for (const k of CONTROLLED) delete childEnv[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  try {
    return JSON.parse(execFileSync(process.execPath, [PROBE], { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    // A probe that dies before writing JSON is itself a result: the boot failed. Surface stderr so a
    // genuine crash is distinguishable from the deliberate hard errors these cases provoke.
    return { ok: false, crashed: true, error: String(e.stderr || e.message).trim() };
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "bureau-secrets-"));
try {
  const secretFile = path.join(tmp, "operator_token");
  const readFile_ = path.join(tmp, "read_token");
  const emptyFile = path.join(tmp, "empty_token");
  const bomFile = path.join(tmp, "bom_token");
  writeFileSync(secretFile, "op_from_secret_file_aaaaaaaa");
  writeFileSync(readFile_, "agent_from_secret_file_bbbb");
  writeFileSync(emptyFile, "   \n  ");
  // A BOM plus a trailing newline: what Set-Content and most editors actually produce.
  writeFileSync(bomFile, "﻿op_with_bom_cccccccccccc\r\n", "utf8");

  // A fake Latch data dir, so the fallback path can be exercised without touching the real one.
  const fakeLatch = path.join(tmp, "latch-data");
  mkdirSync(fakeLatch);
  writeFileSync(path.join(fakeLatch, "auth.json"),
    JSON.stringify({ operatorToken: "op_from_auth_json_dddddddd", agentToken: "agent_from_auth_json_eeee" }));

  // ---- precedence -------------------------------------------------------------------------------
  let r = probe({ OPERATOR_TOKEN_FILE: secretFile, OPERATOR_TOKEN: "op_from_env_should_lose", LATCH_DATA: fakeLatch });
  ok(r.ok, "secret file + env var + auth.json all present: boots");
  ok(r.operator === digest("op_from_secret_file_aaaaaaaa"), "the SECRET FILE wins over both the env var and auth.json");
  ok(/OPERATOR_TOKEN_FILE/.test(r.operatorSource || ""), "and it says so: source names OPERATOR_TOKEN_FILE");

  r = probe({ OPERATOR_TOKEN: "op_from_env_wins_over_disk", LATCH_DATA: fakeLatch });
  ok(r.operator === digest("op_from_env_wins_over_disk"), "with no secret file, the env var beats auth.json");
  ok(/OPERATOR_TOKEN\b/.test(r.operatorSource || "") && !/FILE/.test(r.operatorSource || ""),
     "and the source distinguishes env var from file");

  r = probe({ LATCH_DATA: fakeLatch });
  ok(r.operator === digest("op_from_auth_json_dddddddd"), "with neither, auth.json is still read (bare-metal default intact)");
  ok(/auth\.json/.test(r.operatorSource || ""), "and the source says auth.json");

  // ---- the strong source must not degrade quietly -------------------------------------------------
  // THE CENTRAL ASSERTION. auth.json is present and valid in every one of these, so a fallback would
  // succeed -- silently, with a working Bureau and no boundary. It has to fail instead.
  r = probe({ OPERATOR_TOKEN_FILE: path.join(tmp, "does-not-exist"), LATCH_DATA: fakeLatch });
  ok(!r.ok, "a NAMED but MISSING secret file kills the boot rather than falling back to auth.json");
  ok(/OPERATOR_TOKEN_FILE/.test(r.error || ""), "and the error names the variable that was wrong");

  r = probe({ OPERATOR_TOKEN_FILE: emptyFile, LATCH_DATA: fakeLatch });
  ok(!r.ok, "an EMPTY secret file kills the boot rather than falling back");
  ok(/empty/i.test(r.error || ""), "and says it was empty, not that it was missing");

  r = probe({ OPERATOR_TOKEN_FILE: path.join(tmp, "nope"), OPERATOR_TOKEN: "op_env_must_not_rescue_it", LATCH_DATA: fakeLatch });
  ok(!r.ok, "a missing secret file is not rescued by an env var either");

  // ---- an empty credential is a lockout, so it must be fatal at boot -----------------------------
  r = probe({ OPERATOR_TOKEN: "   " });
  ok(!r.ok, "a whitespace-only OPERATOR_TOKEN is fatal at boot");
  ok(/empty/i.test(r.error || ""), "and is reported as an empty token");

  // ---- invisible bytes ---------------------------------------------------------------------------
  r = probe({ OPERATOR_TOKEN_FILE: bomFile, LATCH_DATA: fakeLatch });
  ok(r.ok && r.operator === digest("op_with_bom_cccccccccccc"),
     "a BOM and a trailing CRLF are stripped, so an editor-written secret still authenticates");

  // ---- read token: same precedence, absent stays quiet -------------------------------------------
  r = probe({ OPERATOR_TOKEN: "op_x", BUREAU_READ_TOKEN_FILE: readFile_, BUREAU_READ_TOKEN: "agent_env_should_lose" });
  ok(r.read === digest("agent_from_secret_file_bbbb"), "read token: secret file wins over env var");
  ok(/BUREAU_READ_TOKEN_FILE/.test(r.readSource || ""), "read token: source names the file variable");

  r = probe({ OPERATOR_TOKEN: "op_x", BUREAU_READ_TOKEN_FILE: path.join(tmp, "absent") });
  ok(!r.ok, "read token: a NAMED but MISSING secret file is fatal, not silently unset");

  r = probe({ OPERATOR_TOKEN: "op_x", LATCH_DATA: path.join(tmp, "no-latch-here") });
  ok(r.ok, "read token: genuinely absent is NOT fatal (the read-only role is optional)");
  ok(r.read === "" && /not configured/.test(r.readSource || ""),
     "read token: absent is reported as 'not configured' rather than guessed at");

  // ---- control: the probe can actually fail, and can actually pass -------------------------------
  // Without this the suite cannot distinguish "every case passed" from "the probe returns ok:true no
  // matter what". The first case here must fail and the second must succeed, through the same path.
  r = probe({ LATCH_DATA: path.join(tmp, "definitely-not-a-latch-dir") });
  ok(!r.ok, "control: no source at all fails (so the checks above are not passing vacuously)");
  r = probe({ OPERATOR_TOKEN: "op_control_value_ffffffff" });
  ok(r.ok && r.operator === digest("op_control_value_ffffffff"), "control: a plain valid env token still boots");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) { console.error(`secret-tokens: ${passed} passed, ${failed} failed`); process.exit(1); }
console.log(`secret-tokens: credential provenance and hard-fail behaviour - ${passed} passed, 0 failed`);
