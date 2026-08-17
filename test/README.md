# Tests

Automated coverage for Bureau. Three tiers: **pure** suites (no server, no model, no network),
**server** suites (need a running server, still no model), and one **live** e2e (needs Latch + the
local model).

## Run everything

```
node test/run-all.mjs --serve   # pure + server suites; boots a throwaway server itself. THE command.
node test/run-all.mjs           # pure suites; server suites only if a server is already up
node test/run-all.mjs --e2e     # also the live autonomy e2e
node test/run-all.mjs --ui      # holds the throwaway server open so the UI can be LOOKED at
```

The runner runs the pure suites always, the server suites only if a server is reachable on
`BUREAU_PORT` (else it skips them with a note), and the live e2e only with `--e2e`. `--serve`
boots one itself, on **a free port of its own** so that two concurrent runs — several worktrees
off one clone, each with a pre-push hook — never share a server; set `BUREAU_PORT` to pin it. A
server it did **not** start is probed on an authenticated route first and refused if that
credential does not work there, rather than handed to the suites to fail as 401s (see TESTING.md).

Current totals: **<!--fig:pure-assertions-->1,594 pure assertions** across
**<!--fig:pure-suites-->17 pure suites**, plus **<!--fig:server-assertions-->311 server assertions**
across **<!--fig:server-suites-->6 server suites** — **<!--fig:assertions-->1,905 headless assertions
across <!--fig:suites-->23 suites** in all. The live `--e2e` adds 18 more and is not counted here,
because it is not part of the pre-push gate.

> Those figures are **checked, not maintained**. `run-all.mjs` compares every number marked
> `<!--fig:…-->` in the docs against what the run just produced and fails if they disagree; the suite
> counts are settled even earlier, in `docs.test.mjs`, straight off the runner's own arrays. If you
> changed the numbers, the failure message says exactly what to write. See `test/doc-figures.mjs`.
>
> Per-suite counts are deliberately **not** written down here. The runner prints them on every run, and
> a figure that has a live readout does not need a second copy that can rot. This file used to claim
> "292 in all" across nine suites while the runner ran far more across twice as many — the numbers and
> the list were both wrong, and nothing was in a position to notice.

## The suites

The authoritative list is the `PURE` / `SERVER` / `LIVE` arrays in `run-all.mjs`; `docs.test.mjs`
asserts that every suite there is described below and that nothing described below has been deleted.

### Pure — no server, no model, no network

| suite | what it establishes |
|---|---|
| `secret-scan.test.mjs` | that no credential is committed. Runs first, so a leak fails before anything else does. Its patterns require the ENTROPY a generated token has and prose does not — `agent_deleted_yesterday` is a real fixture in `workspaces.test.mjs` and matches a naive prefix-and-length rule, and a scanner that fails on a fixture on its first run is a scanner someone switches off. It never prints the value it found: echoing it would put the secret into CI logs and terminal scrollback |
| `decision.test.mjs` | the approval-decision core: the tier truth table, the hard floor under every tier and under run-level auto-approve, policy first-match-wins, and the precedence rule **tier grants → policy loosens/tightens → floor clamps** |
| `units.test.mjs` | the exported helpers — SSRF guard, tolerant JSON parse, action normalization, org normalization, BM25 + RRF ranking, recall de-duplication, vector pack/unpack, remote-mode allowlist, `trimVersions`, the review subsystem's own logic, and much else. By far the largest suite |
| `scope.test.mjs` | the **scope guardrail** — which repository paths a run may open at all, as a rule in the runner rather than a sentence in the prompt |
| `reasoning-cap.test.mjs` | that the thinking cap actually reaches the provider, rather than being asserted structurally one layer above |
| `probe-doctor.test.mjs` | `tools/probe-doctor.mjs` against fixtures it builds itself: is the finding gate's worktree usable, and can a defect there be detected at all |
| `finding-gate.test.mjs` | the **probe gate** against a REAL git repository — real worktree, real check command, real edit, real revert |
| `net.test.mjs` | `apiCall` / `fetchUrl`, offline: input parsing, protocol rejection, and the SSRF guard refusing loopback / link-local / cloud-metadata / private hosts |
| `heartbeat.test.mjs` | `tools/heartbeat.mjs`'s four failure paths and its exit-code contract, always against a **local sink**, never a real watcher |
| `readme-demo.test.mjs` | that the README's pasted `demo-floor` transcript still matches what the tool prints |
| `docs.test.mjs` | this file and the other docs: the figure checker itself, the suite counts, and the suite list above |
| `searchable-source.test.mjs` | that no source file contains a raw NUL byte. Ripgrep treats such a file as binary and stops searching at that point, so one invisible character can hide the rest of a file from every grep — including the greps an audit relies on to establish that something has no callers. The sibling repo lost 238 lines of `server.js` this way |
| `ui.test.mjs` | the browser UI statically — the inline `<script>` parses, and every literal `#id` lookup resolves to an id that exists |
| `action-surface.test.mjs` | that every action the model can reach has somewhere to land: the schema enum, the prompt catalogue, the synonym table and the dispatcher, derived from `server.mjs` and compared. The four parses live in `test/action-surface.mjs` so `docs.test.mjs` can read the counts TESTING.md pins without importing a suite that asserts at import time |
| `hunt-scope.test.mjs` | what `huntRefusal` answers — a review round may not write, buy, send or commit |
| `hunt-dispatch.test.mjs` | that the **runner** enforces that scope rather than the prompt merely asking. Brings its own Bureau and its own stub Latch, which is why it is pure despite spawning |
| `gate-harness.test.mjs` | the runner's own decisions, as pure functions: which port a run picks, and whether a server it did NOT start may be reused — `reuseDiagnosis` is exercised against every status a real server answers with, not just the one that happened to occur |

### Server — need a running server, no model

| suite | what it establishes |
|---|---|
| `api.test.mjs` | the management API: CRUD + validation across company/budget, guardrails, goals, policies, triggers, agents, deliverables, schedules, embeddings, memory, the approval seam, `/api/whoami`, and the auth gate + role separation |
| `workspaces.test.mjs` | workspace isolation — a write to one never reaches another, an unknown id is **refused** rather than silently served from default, and failed-run accounting |
| `endpoints.test.mjs` | the endpoints that predated the coverage ledger: purchases, inbox queues, HR refusals, `hire-plan` cycle resolution, `/api/ceo`, `/api/agent-status` |
| `robustness.test.mjs` | hardening — malformed JSON, oversized fields, a 4 MB body cap, unicode, static-file traversal, not-found sweeps, and the per-workspace write mutex under 15 concurrent writes |
| `mcp-floor.test.mjs` | that the MCP surface can never **decide** an approval. It pins the tool list exactly, so adding any tool trips the test and forces the question to be answered deliberately |
| `mcp-protocol.test.mjs` | that the MCP handshake does not claim a protocol revision Bureau has not implemented |

Every server suite runs inside a **throwaway workspace** it creates and deletes, against the live
SQLite datastore — so they exercise the real persistence layer (atomic transactions, the audit table,
per-workspace isolation) and never touch your real company.

### Live — needs Latch + the local model

`e2e-autonomy.mjs` (`--e2e` only) proves the safe-autonomy stack composes end to end: trusted-tier
auto-approve → a policy `require` overriding the tier → the in-app approval seam → the
Definition-of-Done verdict → a policy `block` refusing a write before any approval is filed → the
GitHub loop, where an agent saves a deliverable and opens a real PR, the floor holds at trusted tier,
the seam approves, and the URL comes back. **18/18 as of 2026-07-31.**

It takes ~13 minutes with retries, which is why it is outside the pre-push gate. Scenarios that need
the model to propose a specific action retry up to 3× and report **INCONCLUSIVE** rather than failed —
a live suite that goes red because a nondeterministic model picked a different tool teaches people to
ignore it.

## What is not covered here

Anything that needs the model, a live Latch, an embedder or real money. Those are scripted and
verified by hand instead, and each one is written up in **[TESTING.md](../TESTING.md)** with what it
measured and when. The rule that keeps that honest is in the same file: **every exported function and
`/api`+`/mcp` route must be either referenced by a test or listed in the coverage ledger with a
reason** — enforced by `node test/coverage-audit.mjs`, which the pre-push hook and CI both run.
