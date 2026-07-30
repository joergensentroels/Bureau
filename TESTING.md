# Bureau — Testing

## Run it

```sh
node test/run-all.mjs --serve     # pure + server suites; boots a throwaway server itself. THE command.
node test/run-all.mjs             # pure suites; server suites only if a server is already up on :4174
node test/run-all.mjs --e2e       # also the live autonomy e2e (needs Latch + a local model)
node test/coverage-audit.mjs      # soft audit: exported fns / routes not tested AND not listed below
```

`--serve` self-hosts a Bureau on :4174 (generating its own `OPERATOR_TOKEN`, so no Latch/auth.json
needed) and tears it down after. Exits non-zero on any failure — it's the pre-push and CI gate.

## The gate (how we avoid pushing broken/untested code)

1. **Pre-push hook** (`.githooks/pre-push`) runs `run-all.mjs --serve` and blocks the push on red.
   Enable once per clone: `git config core.hooksPath .githooks`. Emergency bypass: `git push --no-verify`.
2. **CI** (`.github/workflows/test.yml`) runs the same on every push/PR — the authoritative gate.
3. **This ledger + `coverage-audit.mjs`**: every exported function and `/api`+`/mcp` route must be
   either referenced by a test OR listed under "Intentionally not auto-tested" below (with a reason).
   The rule: **no new export/endpoint ships without a test or a ledger entry.**

## Suites

- **Pure** (`decision`, `units`, `net`) — no server, no model. Logic, validators, SSRF guard, BM25,
  the semaphore, the approval-decision core (incl. hard floor).
- **Server** (`api`, `workspaces`, `robustness`) — hit a running server (no model). CRUD + validation,
  auth gate + role separation, security headers, MCP JSON-RPC, steer routing, SOP CRUD, spend cap,
  workspace isolation, hardening/malformed-input.
- **Live e2e** (`e2e-autonomy`, `--e2e` only) — needs Latch + a local LLM.

## Coverage of the 2026-07 feature + security work

| Area | Where tested |
|---|---|
| Parallel primitive `makeSemaphore` | units |
| Shared memory `rankByRelevance` / `recallSharedMemory` / `/api/memory` | units + api |
| SOPs `normSop` / `sopObjective` / CRUD | units + api |
| `mcp_call` hard-floor | decision |
| MCP server (`/mcp` initialize/tools/list/tools/call/errors) | api |
| Auth gate + role separation + security headers | api |
| Header-only tokens — `?token=` rejected everywhere, incl. the SSE stream | api |
| Failed-auth damper (429 past threshold, cleared by a success) + `kind:"auth"` audit rows | api |
| Damper log-flood bound — 31 failures log ≤3 audit rows | api |
| Remote mode (`BUREAU_REMOTE`) allowlist + fail-closed (`remoteBlocksApproval`, `approvalActType`) | units |
| Vectors: `packVec`/`unpackVec` round-trip, `cosine`, `rrfFuse`, `memoryKey`/`memoryText` | units |
| Hybrid recall — vector+BM25 fusion and every degrade-to-lexical path | units |
| `/api/embeddings` status + `/api/embeddings/backfill` + `/api/memory?lexical=` switch | api |
| Approval seam validation (unknown id → 404, bad decision → 400) | api |
| Role introspection `/api/whoami` (operator + readonly) | api |
| Per-run paid cap (`maxPaidUsdPerRun`) | api |
| Steer endpoint routing+auth | api |
| SSRF guard (`fetchUrl`, `apiCall`, incl. DNS-pin refusals) | net |

## Intentionally not auto-tested (accounted for — audit allowlist)

**Need a live embedding model (manually verified, scripted):**
- `embedText` — the one network call in the vector path. Needs `ollama pull nomic-embed-text`; the
  suites deliberately make no network calls, and every caller treats a null vector as "fall back to
  BM25", which the unit tests do cover. _Verified live 2026-07-30: 45 entries embedded at 768 dims, 0
  failures, and hybrid recall beat BM25 on 6/6 pre-chosen paraphrase queries._

**Need a live Latch (manually verified, scripted):**
- `BUREAU_REMOTE` refusing a real pending approval — needs a pending Latch approval, so the endpoint
  path is verified live (403 + audit row on `act-shell`, deny still 200, `act-note` still approves,
  untagged fails closed). The decision logic itself is unit-tested.
- Per-workspace Inbox filtering via the `ws-` tag (verified live 2026-07-30 after the colon fix).

**Need a live model / Latch (covered by `--e2e`, or manually verified):**
- Parallel `delegate` end-to-end, `ask_peer` / `consultPeer`, `mcp_call` end-to-end (needs a real MCP
  server in Latch's `data/mcp.json`).
- `askLlm`, `paidProviderAvailable`, `initLatchAuth` — thin wrappers over the model/Latch.
- `ragTokens` — trivial tokenizer, exercised transitively by the `rankByRelevance` tests.

**Eval harness internals** (exercised by `eval/run-eval.mjs`, not the unit suite):
`buildDecomposeMsgs`, `buildCriteriaMsgs`, `buildVerifyMsgs`, `validateCriteria`, `validateVerify`,
`validateDecompose`.

**Latch-proxy / read endpoints** (thin pass-throughs to Latch, or return live state — validated
manually / via Latch's own tests): `/api/state`, `/api/llm/chat`, `/api/llm/config`,
`/api/mcp/servers`, `/api/github/config`, `/api/bio/generate`.

**Pre-existing endpoints not yet back-filled with tests (acknowledged backlog, predate this work):**
`/api/purchases`, `/api/inbox`, `/api/inbox/seen`, `/api/ceo`, `/api/agent-status`, `/api/hr/suggest`,
`/api/hr/plan`, `/api/hr/hire-plan`, `/relocate`.
