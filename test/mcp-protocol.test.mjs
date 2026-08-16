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
// The modern era (2026-07-28), served beside the handshake above.
// ---------------------------------------------------------------------------
// Bureau is now DUAL-ERA. The spec's compatibility matrix gives Legacy+Dual-era = Works and
// Modern+Dual-era = Works, and a dual-era server picks its behaviour from how the client opened: a
// request carrying per-request `_meta` is served statelessly; an `initialize` request selects legacy
// semantics. Everything above this line is the legacy half and must keep passing unchanged — that is
// the half a client already talking to Bureau depends on.
const MODERN = "2026-07-28";
const NS = "io.modelcontextprotocol/";
const meta = (version = MODERN) => ({
  [NS + "protocolVersion"]: version,
  [NS + "clientInfo"]: { name: "pin", version: "1" },
  [NS + "clientCapabilities"]: {},
});
// Sends the mirrored headers the transport requires, so the happy path here is a CONFORMING client.
const modern = async (method, params = {}, { version = MODERN, headers = {}, name } = {}) => {
  const body = { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta(version) } };
  const h = {
    "content-type": "application/json",
    "mcp-protocol-version": version,
    "mcp-method": method,
    ...(name !== undefined ? { "mcp-name": name } : {}),
    ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    ...headers,
  };
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  const r = await fetch(`${B}/mcp`, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const disc = await modern("server/discover");
ok("server/discover is implemented — the spec says servers MUST implement it",
  disc.status === 200 && !disc.body?.error, `status ${disc.status} ${JSON.stringify(disc.body).slice(0, 160)}`);
ok("  and its result carries resultType 'complete'", disc.body?.result?.resultType === "complete",
  `got ${JSON.stringify(disc.body?.result?.resultType)}`);
ok("  and names both eras in supportedVersions",
  (disc.body?.result?.supportedVersions || []).includes(MODERN)
  && (disc.body?.result?.supportedVersions || []).includes(EXPECT),
  `got ${JSON.stringify(disc.body?.result?.supportedVersions)}`);
ok("  and reports serverInfo in _meta, which servers SHOULD do",
  typeof disc.body?.result?._meta?.[NS + "serverInfo"]?.name === "string",
  `got ${JSON.stringify(disc.body?.result?._meta)}`);

// resultType is required on EVERY result, not just discover's.
const mlist = await modern("tools/list");
ok("tools/list over the modern path carries resultType", mlist.body?.result?.resultType === "complete",
  `got ${JSON.stringify(mlist.body?.result?.resultType)}`);
ok("  and still returns the tools", Array.isArray(mlist.body?.result?.tools) && mlist.body.result.tools.length > 0);

// A missing required _meta field is MALFORMED (-32602 + HTTP 400), not unsupported. This is also what
// makes the era routing safe: a modern method arriving without its metadata is answered as a broken
// modern request rather than as an unknown legacy method, which would misreport Bureau as legacy-only.
const noMeta = await fetch(`${B}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", "mcp-protocol-version": MODERN, "mcp-method": "server/discover", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
});
const noMetaBody = await noMeta.json().catch(() => null);
ok("server/discover without _meta is -32602 AND HTTP 400",
  noMeta.status === 400 && noMetaBody?.error?.code === -32602,
  `status ${noMeta.status} ${JSON.stringify(noMetaBody?.error)}`);

// An unsupported version names what IS supported, so the client can retry rather than guess.
const badVer = await modern("tools/list", {}, { version: "1900-01-01" });
ok("an unsupported version is -32022 AND HTTP 400", badVer.status === 400 && badVer.body?.error?.code === -32022,
  `status ${badVer.status} ${JSON.stringify(badVer.body?.error)}`);
ok("  and lists the versions the server does support",
  (badVer.body?.error?.data?.supported || []).includes(MODERN)
  && badVer.body?.error?.data?.requested === "1900-01-01",
  `got ${JSON.stringify(badVer.body?.error?.data)}`);

// Header/body agreement. The point is not tidiness: an intermediary may route on the header while the
// server executes the body, so a disagreement must never be acted on.
const hdrWrong = await modern("tools/list", {}, { headers: { "mcp-method": "tools/call" } });
ok("a Mcp-Method header disagreeing with the body is -32020 AND HTTP 400",
  hdrWrong.status === 400 && hdrWrong.body?.error?.code === -32020,
  `status ${hdrWrong.status} ${JSON.stringify(hdrWrong.body?.error)}`);
const verWrong = await modern("tools/list", {}, { headers: { "mcp-protocol-version": EXPECT } });
ok("a MCP-Protocol-Version header disagreeing with _meta is -32020",
  verWrong.status === 400 && verWrong.body?.error?.code === -32020,
  `got ${JSON.stringify(verWrong.body?.error)}`);
const noHdr = await modern("tools/list", {}, { headers: { "mcp-method": undefined } });
ok("a missing Mcp-Method header is -32020", noHdr.status === 400 && noHdr.body?.error?.code === -32020,
  `got ${JSON.stringify(noHdr.body?.error)}`);

// tools/call mirrors params.name into Mcp-Name, and the base64 sentinel must be decoded before comparing.
const callOk = await modern("tools/call", { name: "list_agents", arguments: {} }, { name: "list_agents" });
ok("tools/call with a matching Mcp-Name succeeds", callOk.status === 200 && !callOk.body?.error,
  `status ${callOk.status} ${JSON.stringify(callOk.body?.error)}`);
const callB64 = await modern("tools/call", { name: "list_agents", arguments: {} },
  { name: "=?base64?" + Buffer.from("list_agents", "utf8").toString("base64") + "?=" });
ok("  and a base64-sentinel Mcp-Name is decoded before comparison, not rejected",
  callB64.status === 200 && !callB64.body?.error, `status ${callB64.status} ${JSON.stringify(callB64.body?.error)}`);
const callBad = await modern("tools/call", { name: "list_agents", arguments: {} }, { name: "list_sops" });
ok("  while a Mcp-Name naming a DIFFERENT tool is refused -32020", callBad.body?.error?.code === -32020,
  `got ${JSON.stringify(callBad.body?.error)}`);

// An unimplemented method is 404 on this transport, so a client can tell it apart from an endpoint that
// is not an MCP endpoint at all. The JSON-RPC body is what separates those two 404s.
const gone = await modern("resources/read", { uri: "x" });
ok("an unimplemented modern method is -32601 AND HTTP 404",
  gone.status === 404 && gone.body?.error?.code === -32601,
  `status ${gone.status} ${JSON.stringify(gone.body?.error)}`);

// PERMANENT CONTROL, and the one that protects everything a current client relies on: adding the modern
// era must not have moved the legacy handshake. If this ever fails, the dual-era claim is void.
const stillLegacy = await initialize(EXPECT);
ok("CONTROL: the legacy handshake still answers after the modern path was added",
  stillLegacy.status === 200 && stillLegacy.body?.result?.protocolVersion === EXPECT,
  `got ${JSON.stringify(stillLegacy.body?.result)}`);
ok("CONTROL: and a legacy result carries NO resultType (absent means 'complete' to those clients)",
  stillLegacy.body?.result?.resultType === undefined,
  `got ${JSON.stringify(stillLegacy.body?.result?.resultType)}`);

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
// Derived from what the SERVER just said it supports, not from a list kept here by hand. This assertion
// used to read "states the newer revisions are NOT implemented" and checked only that two strings appeared
// somewhere in the file — which stayed green through the change that made one of them true, and would have
// stayed green through a change that made it false again. What has to hold is that the document names every
// revision the server serves.
for (const v of disc.body?.result?.supportedVersions || []) {
  ok(`MCP-PROTOCOL-SUPPORT.md names ${v}, which server/discover reports as supported`, doc.includes(v),
    `doc is ${doc.length} bytes and does not mention ${v}`);
}
ok("  and still names 2025-11-25, the revision between them that Bureau does not implement",
  doc.includes("2025-11-25"));
ok("  and the doc does not still claim the modern revision is unimplemented",
  !/2026-07-28[^\n]*\|\s*not implemented/.test(doc),
  "the revision table still marks 2026-07-28 as not implemented");

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
