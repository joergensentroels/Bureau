// The MCP handshake must not claim a revision Bureau has not implemented.
//
//   start:  BUREAU_PORT=4174 node server.mjs
//   run:    BUREAU_PORT=4174 node test/mcp-protocol.test.mjs
//
// `/mcp` used to answer `initialize` with `m.params?.protocolVersion || MCP_PROTOCOL` — it echoed the
// client's request straight back. A client announcing 2026-07-28 was told "yes, I speak 2026-07-28",
// and discovered otherwise only when it went looking for `server/discover` (absent here), `resultType`
// on every result (absent), or `_meta` parsing (absent). Nothing under test/ mentioned protocolVersion
// at all, so the claim was unpinned in both directions: nothing recorded what Bureau spoke, and nothing
// would have noticed it change.
//
// Every version check below is a POSITIVE equality, deliberately. The tempting shape is
// `ok(v !== "2026-07-28")` — "assert we don't claim the new one" — and it is vacuous: it passes when v
// is undefined, which is what you get when the server is down, when initialize returns an error, when
// auth fails, and when the field is dropped from the result entirely. Asserting the exact revision
// Bureau does implement goes red in all four of those states.
const PORT = process.env.BUREAU_PORT || 4174;
const B = `http://127.0.0.1:${PORT}`;
const TOKEN = (process.env.OPERATOR_TOKEN || "").trim();

// The revision Bureau implements. Hard-coded rather than imported from server.mjs on purpose: importing
// the constant would make this test agree with the server by construction, and it would still agree
// after someone edited the constant to something Bureau cannot speak. The point of a pin is to be an
// independent statement of the same fact, so that changing one and not the other is what fails.
const EXPECT = "2025-06-18";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
};
const rpc = async (method, params) => {
  const r = await fetch(`${B}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const initialize = (protocolVersion) =>
  rpc("initialize", protocolVersion === undefined ? {} : { protocolVersion, capabilities: {}, clientInfo: { name: "pin", version: "1" } });

// ---------------------------------------------------------------------------
// Liveness first, so nothing below can pass because MCP is unreachable.
// ---------------------------------------------------------------------------
const live = await initialize(EXPECT);
ok("initialize answers at all (this file is not passing because /mcp is down or unauthorised)",
  live.status === 200 && !live.body?.error && typeof live.body?.result?.protocolVersion === "string",
  `status ${live.status} ${JSON.stringify(live.body).slice(0, 160)}`);

// ---------------------------------------------------------------------------
// Negotiation, both halves of the rule.
// ---------------------------------------------------------------------------

// "If the server supports the requested protocol version, it MUST respond with the same version."
ok(`a client asking for ${EXPECT} is answered ${EXPECT}`,
  live.body?.result?.protocolVersion === EXPECT,
  `got ${JSON.stringify(live.body?.result?.protocolVersion)}`);

// "Otherwise, the server MUST respond with another protocol version it supports." These are the two
// revisions that actually exist beyond ours, and the whole reason this file was written: under the echo
// they came back verbatim, which was Bureau claiming a wire format it has none of.
for (const newer of ["2026-07-28", "2025-11-25"]) {
  const r = await initialize(newer);
  ok(`a client asking for ${newer} is answered ${EXPECT}, not ${newer}`,
    r.status === 200 && r.body?.result?.protocolVersion === EXPECT,
    `got ${JSON.stringify(r.body?.result?.protocolVersion)}`);
}

// Unknown/garbage versions take the same path — the check is membership, not "is it newer than ours".
for (const junk of ["1900-01-01", "banana", ""]) {
  const r = await initialize(junk);
  ok(`a client asking for ${JSON.stringify(junk)} is answered ${EXPECT}`,
    r.status === 200 && r.body?.result?.protocolVersion === EXPECT,
    `got ${JSON.stringify(r.body?.result?.protocolVersion)}`);
}

// A client that omits the field entirely still gets a definite answer.
const bare = await initialize(undefined);
ok(`initialize with no protocolVersion is answered ${EXPECT}`,
  bare.status === 200 && bare.body?.result?.protocolVersion === EXPECT,
  `got ${JSON.stringify(bare.body?.result?.protocolVersion)}`);

// ---------------------------------------------------------------------------
// Era detection. This is the load-bearing accident.
// ---------------------------------------------------------------------------
// A dual-era client probes `server/discover` and "falls back on any error that is not a recognized
// modern error". Bureau answering a plain -32601 is what makes that fallback fire and land on the
// `initialize` handshake it does implement. Answering -32022 (UnsupportedProtocolVersionError) would
// look more up-to-date and be strictly worse: a recognized modern error identifies the server as
// MODERN, so the client would retry modern requests forever instead of falling back. That is a
// plausible-looking "improvement", which is why it is pinned rather than left to the comment.
const disc = await rpc("server/discover", {});
ok("server/discover fails as a plain -32601, marking Bureau a legacy-era server",
  disc.body?.error?.code === -32601,
  `got ${JSON.stringify(disc.body?.error)}`);
ok("server/discover does NOT return a modern error code (that would misidentify Bureau as modern)",
  disc.body?.error?.code === -32601 && disc.body?.error?.code !== -32022,
  `got ${JSON.stringify(disc.body?.error?.code)}`);

// ---------------------------------------------------------------------------
// The claim and the written scope must not drift apart.
// ---------------------------------------------------------------------------
// The original defect was a version number with nowhere saying what it covered. Keeping the doc in the
// assertion means the next person to change the revision has to change the record of what it means.
const { readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const path = await import("node:path");
const DOC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "MCP-PROTOCOL-SUPPORT.md");
let doc = "";
try { doc = readFileSync(DOC, "utf8"); } catch (e) { doc = ""; }
ok("MCP-PROTOCOL-SUPPORT.md exists (the version claim has a written scope)", doc.length > 0, DOC);
ok(`MCP-PROTOCOL-SUPPORT.md names the revision the server actually answers (${EXPECT})`,
  doc.includes(EXPECT),
  `doc is ${doc.length} bytes and does not contain ${EXPECT}`);
ok("MCP-PROTOCOL-SUPPORT.md states the newer revisions are NOT implemented",
  doc.includes("2026-07-28") && doc.includes("2025-11-25"),
  "both newer revisions should be named and disclaimed");

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
