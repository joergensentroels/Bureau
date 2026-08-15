# MCP protocol support

**Bureau speaks Model Context Protocol revision `2025-06-18`, and only that revision.**

Recorded 2026-08-15. This file exists because the version number on its own was not enough: `/mcp`
declared `2025-06-18` while its `initialize` handler answered with *whatever version the client asked
for*, so a client announcing `2026-07-28` was told Bureau spoke `2026-07-28`. Nothing was written down
about what the number covered, and nothing in `test/` referenced it, so the claim drifted for free.

If you change `MCP_PROTOCOLS` in `server.mjs`, change this file in the same commit.
`test/mcp-protocol.test.mjs` fails if the server and this document disagree.

## Where the revisions stand

| Revision | Era | Bureau |
| --- | --- | --- |
| `2025-06-18` | legacy (`initialize` handshake) | **implemented** |
| `2025-11-25` | legacy | not implemented |
| `2026-07-28` | modern (per-request `_meta`) | not implemented |

"Legacy" and "modern" are the `2026-07-28` spec's own terms, not softening. Modern revisions carry
version, identity and capabilities as per-request metadata; legacy revisions establish a session with an
`initialize` handshake. Bureau is a legacy-era server and reports itself as one.

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

### `server/discover` returns `-32601`, and that is deliberate

A dual-era client works out what it is talking to by probing `server/discover` and falling back to
`initialize` on any error that is *not* a recognized modern error. Bureau's plain `-32601` is what makes
that fallback fire and land on the handshake it does implement.

Returning `-32022` (`UnsupportedProtocolVersionError`) here would look more current and would be
strictly worse: a recognized modern error identifies the server as **modern**, so the client would retry
modern requests instead of falling back, and never reach the handshake at all. This is pinned in
`test/mcp-protocol.test.mjs` precisely because "use the newer error code" reads like an improvement.

## Why `2026-07-28` is not being implemented

It is a rewrite of the transport contract, not a version bump. It removes `initialize`,
`notifications/initialized`, protocol-level sessions and `Mcp-Session-Id`; and it requires a
`server/discover` RPC, a mandatory `resultType` on every result, `_meta` parsing on every request,
`Mcp-Method` / `Mcp-Name` transport headers, `ttlMs` + `cacheScope` on list and read results, Tasks
moved to a polled extension, and Multi Round-Trip Requests in place of persistent channels for
elicitation and sampling.

Bureau's `/mcp` is a tools-only surface on a loopback interface behind an operator token. Almost none of
that machinery buys it anything today, and a half-done modern implementation would be the same defect
again in a more expensive form. The honest position is one implemented revision, declared accurately.

The trigger to revisit is a client Bureau actually needs to talk to that is modern-only. At that point
the compatibility matrix says a legacy server and a modern client simply fail, and the work becomes
real rather than anticipatory.

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
