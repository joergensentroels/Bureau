# MCP protocol support

**Bureau is a DUAL-ERA MCP server: it speaks `2026-07-28` (modern) and `2025-06-18` (legacy).**

Recorded 2026-08-15, revised 2026-08-16 when the modern era was implemented. This file exists because the
version number on its own was not enough: `/mcp` declared `2025-06-18` while its `initialize` handler
answered with *whatever version the client asked for*, so a client announcing `2026-07-28` was told Bureau
spoke `2026-07-28`. Nothing was written down about what the number covered, and nothing in `test/`
referenced it, so the claim drifted for free.

If you change `MCP_PROTOCOLS` in `server.mjs`, change this file in the same commit.
`test/mcp-protocol.test.mjs` fails if the server and this document disagree — it reads the supported list
out of a live `server/discover` response and requires this file to name every revision in it.

## Where the revisions stand

| Revision | Era | Bureau |
| --- | --- | --- |
| `2025-06-18` | legacy (`initialize` handshake) | **implemented** |
| `2025-11-25` | legacy | not implemented |
| `2026-07-28` | modern (per-request `_meta`) | **implemented** |

"Legacy" and "modern" are the `2026-07-28` spec's own terms. Modern revisions carry version, identity and
capabilities as per-request metadata; legacy revisions establish a session with an `initialize` handshake.
Bureau serves both, which the spec explicitly provides for:

> A server that wishes to support both legacy clients (which expect an `initialize` handshake) and modern
> clients (which use per-request metadata) **MAY** implement both behaviors.

— MCP `2026-07-28`, Versioning and Compatibility. Its compatibility matrix gives **Legacy + Dual-era =
Works** and **Modern + Dual-era = Works**, which is the whole reason for doing it this way: no client that
works against Bureau today stops working, and modern-only clients start.

**The era is chosen by how the client opens, never by anything remembered.** A request carrying
per-request `_meta` is served statelessly under `2026-07-28`. An `initialize` request selects legacy
semantics. `server/discover` counts as modern even without `_meta`, so a discover call that forgot its
metadata is answered as a malformed *modern* request (`-32602`) rather than as an unknown legacy method
(`-32601`) — the first tells the client what to fix, the second would tell it Bureau is legacy-only, which
is no longer true.

`initialize` negotiates from the LEGACY list alone. Answering it with `2026-07-28` would name a revision
that has no handshake, leaving the client believing it had agreed a version whose session does not exist.

## What is implemented

JSON-RPC 2.0 over HTTP at `POST /mcp`, operator token required, bound to `127.0.0.1`.

| Method | Behaviour |
| --- | --- |
| `initialize` | Negotiates a version (below) and advertises `capabilities: { tools: {} }` |
| `notifications/*` | Accepted, no response — including `notifications/initialized` |
| `ping` | Empty result |
| `tools/list` | The seven tools pinned by `test/mcp-floor.test.mjs` |
| `tools/call` | Text content; write tools require the operator role |

Everything else returns `-32601`. There are no resources, no prompts, no completions, no logging, no
sampling, no elicitation, and no server-initiated requests of any kind.

## What the handshake does

Bureau answers `initialize` with a version it actually implements, and leaves the client to decide
whether that is good enough. This is the behaviour the lifecycle spec defines, not a local invention:

> If the server supports the requested protocol version, it MUST respond with the same version.
> Otherwise, the server MUST respond with another protocol version it supports.

— MCP `2025-06-18`, Lifecycle / Version Negotiation. The same section puts the next move on the client:
if it does not support the version in the server's response, it should disconnect. So a client asking
for `2026-07-28` now gets `2025-06-18` back and can hang up on the spot, instead of proceeding under a
false agreement and failing later at the first missing feature.

### `server/discover` is implemented, which supersedes an earlier decision here

This file previously argued that answering `server/discover` with a plain `-32601` was load-bearing: a
dual-era client probes it and falls back to `initialize` on any error that is *not* a recognized modern
error, so the plain `-32601` was what made that fallback fire. **That reasoning was correct for a
legacy-only server and is now obsolete.** The spec says servers **MUST** implement `server/discover`, and
a dual-era server should be identified as modern-capable — legacy clients still reach `initialize`, which
is the matrix's Legacy + Dual-era row.

The specific trap it warned about still exists and is still pinned: `-32020`–`-32099` is reserved for the
specification, and an implementation **MUST NOT** emit a code in that range the spec does not define.
Bureau emits exactly three: `-32020` `HeaderMismatch`, `-32022` `UnsupportedProtocolVersion`, and no
others. `-32021` `MissingRequiredClientCapability` is defined but unused, because Bureau's tools require
no client capability.

## What the modern era enforces

| Rule | Behaviour |
| --- | --- |
| `_meta` per request | `protocolVersion` and `clientCapabilities` are REQUIRED on every request; missing → `-32602` + HTTP 400. `clientInfo` is SHOULD, so its absence is fine |
| Version support | Unknown revision → `-32022` + HTTP 400, with `data.supported` and `data.requested` so the client can retry |
| Mirrored headers | `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` (on `tools/call`) must agree with the body → `-32020` + HTTP 400. `Mcp-Name` is decoded from the `=?base64?…?=` sentinel before comparing |
| `resultType` | Every modern result carries `resultType: "complete"`. Legacy results deliberately do NOT — clients of earlier revisions are told to read an absent `resultType` as `"complete"` |
| `serverInfo` | Returned in every modern result's `_meta`, which servers SHOULD do |
| Unknown method | `-32601` + HTTP **404**, so a client can tell an unimplemented method from an endpoint that is not an MCP endpoint at all |
| Batching | Arrays are answered on the legacy path only. `2025-06-18` removed batching and `2026-07-28` requires a single request or notification per POST |

Header agreement is a security control, not tidiness: the transport mirrors body fields into headers so
intermediaries can route without parsing the body, and a load balancer routing on `Mcp-Name` while the
server executes `params.name` is exactly the divergence `-32020` exists to prevent.

## What is still not implemented

`2025-11-25` — the legacy revision between the two Bureau serves. Nothing has been verified against it.

Within `2026-07-28`: no resources, prompts, completions, logging, sampling or elicitation; no
`subscriptions/listen` stream; no Tasks extension; no `ttlMs`/`cacheScope` on results (they are optional,
and Bureau's lists are cheap enough that advertising a cache would claim more than it knows). Multi
Round-Trip Requests are not implemented because Bureau's tools never need input back from the client —
every approval it needs goes to the operator through Latch, not through MCP.

The tool surface is unchanged by the modern era and is pinned separately by `test/mcp-floor.test.mjs`:
this endpoint can start runs, and it can never decide an approval.

## Known gaps within `2025-06-18`

Named here rather than left to be discovered:

- **`MCP-Protocol-Version` header is not validated.** The spec requires clients to send it on requests
  after initialization; Bureau ignores it. Nothing breaks, but Bureau will not catch a client that
  negotiated one revision and then spoke another.
- **JSON-RPC batching is accepted.** `2025-06-18` removed it. Bureau still processes arrays of messages,
  which is more permissive than the revision requires rather than less.
- **The declared list holds one entry.** Older revisions may well be wire-compatible with this tools-only
  surface, but nobody has checked, so nothing claims them. Widening `MCP_PROTOCOLS` is a deliberate act
  with a verification attached — which is the whole point of this file.

## Related

- `test/mcp-protocol.test.mjs` — pins the negotiation, the era-detection error code, and this document
- `test/mcp-floor.test.mjs` — pins the tool surface: the MCP side must never be able to decide an approval
- Latch's `MCP-PROTOCOL-SUPPORT.md` — the same decision on the client side, plus the URL-mode elicitation
  opportunity that bears on Bureau's elicitation roadmap item
