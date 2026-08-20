// Child process for secret-tokens.test.mjs. Resolves Bureau's two credentials under whatever env the
// parent set, and prints WHERE each came from plus a digest of the value.
//
// A child rather than an in-process import, because DATA_DIR is computed from LATCH_DATA at module load
// time. A single import fixes it for the life of the process, so the auth.json fallback cannot be
// exercised alongside the secret-file cases from one test process.
//
// IT NEVER PRINTS A TOKEN. The auth.json fallback reads the operator's REAL credential on a developer
// machine -- that token is shell access to this host -- and a test that echoes it would put it into
// terminal scrollback, CI logs and any pasted bug report. Eight hex characters of SHA-256 is enough for
// the parent to assert "this is the value I planted" while being useless to anyone who reads it.
import { createHash } from "node:crypto";
import { initLatchAuth, initReadToken, tokenSource, readTokenSource } from "../server.mjs";

const digest = (v) => (v ? createHash("sha256").update(String(v)).digest("hex").slice(0, 8) : "");

const out = { ok: true };
try {
  out.operator = digest(await initLatchAuth());
  out.operatorSource = tokenSource();
} catch (e) {
  out.ok = false;
  out.error = e.message;
}
if (out.ok) {
  try {
    out.read = digest(await initReadToken());
    out.readSource = readTokenSource();
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  }
}
process.stdout.write(JSON.stringify(out));
