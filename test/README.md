# Tests

Automated coverage for Bureau. Three tiers: **pure** unit tests (no dependencies),
**server** tests (need a running server, no model), and one **live** e2e (needs
Latch + the local model).

## Run everything

```
node test/run-all.mjs          # pure suites + server suites (if a server is up)
node test/run-all.mjs --e2e    # also the live autonomy e2e
```

The runner runs the pure suites always, the server suites only if a server is
reachable on `BUREAU_PORT` (else it skips them with a note), and the live e2e only
with `--e2e`. Current totals: **187 pure assertions + 87 server assertions** (plus
the 10-assertion live e2e) — 274 in all.

### What's covered vs. not

Covered (deterministic, headless): the safe-autonomy decision core, the SSRF guard
(pure IPs + the `apiCall`/`fetchUrl` entry points), action normalization, the
delegation matcher, org normalization, RAG ranking, filename safety, the full
management API (agents / goals / policies / triggers / schedules / guardrails /
deliverable lifecycle / reporting), workspace isolation, static-file traversal, and
input/concurrency hardening (malformed bodies, oversized fields, a 4 MB body cap,
unicode, the per-workspace write mutex).

Not covered here (LLM- or Latch-bound — exercised by the `--e2e` suite instead): the
deep delegation/decompose recursion, agent bio generation, HR suggestions, a live
trigger firing a run, and deliverable revision/versioning. These need the model and a
real Latch, so they can't be asserted deterministically.

## `decision.test.mjs` — pure unit tests (fast, no server)

Exercises the decision core directly via the functions `server.mjs` exports —
`decideApproval()` and `evaluatePolicy()`. No server, no Latch, no model.

```
node test/decision.test.mjs
```

Covers the tier truth table, the hard floor under every tier and under run-level
auto-approve, policy matching / first-match-wins / disabled-rule skipping, and the
precedence rule **tier grants → policy loosens/tightens → floor clamps** — including
the guarantee that a policy `allow` can never auto-approve a floored action.

## `units.test.mjs` — pure unit tests for standalone logic (fast, no server)

101 assertions over the exported helpers: the **SSRF guard** (`ipv4Blocked` /
`ipBlocked` — every private/internal range + IPv6/mapped), `normalizeAction` (the
"do what the model meant" action corrections), `safeParse` (tolerant JSON),
`ragTerms`, `expectsDeliverable`, `resolveReport` (tolerant assignee matching, no
double-assignment), `goalObjective`, `normKRs`, `cadenceMs`, `cleanPolicyWhen`,
`htmlToText`, `ensureBudget` (org normalization + safe agent defaults),
`renderChecklist` (the DoD checklist markdown), `validDeliverableName` (the API
filename gate), and `rankDeliverables` (the pure RAG keyword ranker).

## `net.test.mjs` — outbound-network helpers, offline (fast, no server)

13 assertions over `apiCall` and `fetchUrl`: input parsing (JSON request vs plain
URL), protocol rejection, and the **SSRF guard** refusing loopback / link-local /
cloud-metadata / private hosts. Every case short-circuits before any real network
I/O (DNS on an IP literal resolves locally), so it needs no live hosts.

```
node test/net.test.mjs
```

```
node test/units.test.mjs
```

## `api.test.mjs` — model-free API/CRUD + validation (needs a running server)

46 assertions over the management endpoints — company/budget, guardrails (clamping),
notify (url validation), goals lifecycle, policies validation + CRUD, triggers CRUD
(+ bad-token rejection on the public endpoint), agents (tier validation), deliverable
status transitions + versions endpoint + name/status validation, schedules CRUD, the
goal-cadence → linked-schedule wiring, and the reporting endpoints (dashboard / runs /
performance / audit-filtering). Runs entirely **inside a throwaway workspace** it
creates and deletes, so your real company is never touched.

```
BUREAU_PORT=4174 node server.mjs
BUREAU_PORT=4174 node test/api.test.mjs
```

## `robustness.test.mjs` — hardening / edge cases (needs a running server)

30 assertions: unknown route / wrong method → 404, malformed JSON body handled
gracefully (not a 500), oversized **fields** truncated, an oversized **request body**
(>4 MB) → 413, unicode / control chars in names accepted and length-capped, a
non-ASCII workspace name still producing a filename-safe id, **static-file traversal
blocked** (can't read the org file or source via `/..%2f..%2f…`), run-lifecycle
endpoints on unknown ids (stop is idempotent; plan/stream → 404), a not-found sweep
(PATCH/DELETE unknown agent/goal/policy/trigger/schedule/workspace → 404), numeric
clamping (negative/NaN → 0), agent-field round-trips (allow de-duped/lowercased,
lessons cleaned), and the **concurrent-write guarantee** — 15 simultaneous writes to
one workspace all land (the per-workspace mutex loses none). Also in a throwaway workspace.

```
BUREAU_PORT=4174 node server.mjs
BUREAU_PORT=4174 node test/robustness.test.mjs
```

## `e2e-autonomy.mjs` — live end-to-end (needs a running server + Latch + model)

Drives real company runs and asserts the layers compose:
tier auto-approve → a policy `require` override → the **in-app approval seam** →
the Definition-of-Done verdict → a policy `block`.

```
BUREAU_PORT=4174 node server.mjs          # in one shell
BUREAU_PORT=4174 node test/e2e-autonomy.mjs   # in another
```

The runs are real: they create deliverables in `drafts/` and file/resolve Latch
approvals. The test discovers an agent from the org, restores its tier, and clears
the policies it adds — but it does **not** delete the `welcome-*` / `thank-you-*`
drafts it produces, so remove those by hand if you don't want the sample output.

## `workspaces.test.mjs` — workspace isolation (needs a running server)

Proves each workspace is a fully separate company: new workspaces start empty,
writes to one never touch another (or the default), an unknown workspace id falls
back to default, and delete removes a workspace's data while leaving default intact.
Uses only throwaway workspaces it creates and deletes — it never mutates default.

```
BUREAU_PORT=4174 node server.mjs
BUREAU_PORT=4174 node test/workspaces.test.mjs
```
