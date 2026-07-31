# Bureau — Testing

## Run it

```sh
node test/run-all.mjs --serve     # pure + server suites; boots a throwaway server itself. THE command.
node test/run-all.mjs             # pure suites; server suites only if a server is already up on :4174
node test/run-all.mjs --e2e       # also the live autonomy e2e (needs Latch + a local model)
node test/coverage-audit.mjs      # soft audit: exported fns / routes not tested AND not listed below
node eval/recall-eval.mjs         # recall@3 of memory retrieval, shipped ranker vs alternatives (live)
node eval/parallel-eval.mjs       # sequential-vs-parallel delegation A/B, repeated runs (live, ~4min/pair)
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
- **Server** (`api`, `workspaces`, `endpoints`, `robustness`) — hit a running server (no model). CRUD + validation,
  auth gate + role separation, security headers, MCP JSON-RPC, steer routing, SOP CRUD, spend cap,
  workspace isolation, hardening/malformed-input.
- **Live e2e** (`e2e-autonomy`, `--e2e` only) — needs Latch + a local LLM. Proves the safe-autonomy stack
  composes: trusted-tier auto-approve → policy `require` overriding the tier → the in-app approval seam →
  DoD verdict → policy `block` refusing a write before any approval is filed → **the GitHub loop** (agent
  saves a deliverable, opens a real PR, floor holds at trusted tier, seam approves, URL returns).
  _**18/18** as of 2026-07-31, up from 9; before that it had never been run since the auth gate landed in July._
  - **S4 (GitHub) exists because two bugs hid in exactly the seam it crosses** while 32 tests passed — they
    all stopped at one system's edge. Two of its assertions name those defects outright, so a regression
    fails with the reason attached. It **skips** (inconclusive, exit 0) when GitHub isn't configured.
  - **Scenario order is state.** S3 leaves a policy blocking `file_write`; S4 calls `reset()` first because
    without it the agent can't save a deliverable and `github_pr` correctly refuses to PR nothing — which
    the first run misreported as "the model chose a different action". Teardown-only reset worked until a
    fourth scenario disagreed with the third.
  - **~13 minutes with retries**, which is why it stays outside the pre-push gate. S1 needed 2 attempts and
    S2 needed 3 in the passing run; that's the nondeterminism the retry design is for.
  - Scenarios that need the model to propose a specific action **retry up to 3×** and report
    **INCONCLUSIVE**, not failed, if it never does — exit code stays 0. A live suite that goes red
    because a nondeterministic model picked a different tool teaches people to ignore it.
  - **It stops every run it started before tidying up.** `runAndStream` timing out used to walk away from a
    run that kept executing, proposing actions and filing approvals *after* teardown took its id-diff —
    which left real approvals in the operator's Latch inbox for hours while the teardown reported success.
    A timeout now stops the run, teardown stops them all again, and it sweeps **twice** with a pause
    (stopping is cooperative, so an in-flight action can still file one). Stragglers are counted separately,
    and a final re-diff prints `verified: no approval this test caused is still pending` or names the ids.
    _Abandoning a stream is not abandoning the work behind it._
  - Teardown restores the policies and tier it changed, denies **only** approvals that appeared during
    the run, and removes **only** deliverables that appeared during the run — both diffed against a
    startup baseline, so it can never touch something it didn't cause. `DELETE` archives into
    `.versions/` and the archive name is printed, so nothing it removes is unrecoverable. Anything it
    fails to remove is reported loudly rather than folded into a clean-looking summary.
    _Until 2026-07-31 this read "it cannot remove the deliverables its runs write — there is no delete
    endpoint". That was accurate when written and silently became false the moment the endpoint landed:
    a documented limitation is a claim, and claims go stale._
  - **The removal branch has not been observed firing.** S2 writes a deterministic filename, so once
    that document exists it is in every later run's startup baseline and no run can produce one the
    diff calls new — meaning the old "LEFT BEHIND" notice only ever fired on the very first e2e run.
    To exercise removal for real, delete the e2e's output document first (note that this changes the
    retrieval corpus `eval/recall-eval.mjs` measures, so re-baseline it in the same session).

## Coverage of the 2026-07 feature + security work

| Area | Where tested |
|---|---|
| Parallel primitive `makeSemaphore` — reaches the cap, not merely stays under it | units |
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
| Recall de-dup: `objectiveSignature`, `dedupeMemories`, summary-over-recency, per-agent scope | units |
| Deliverable ranking (BM25 over filename+content) + `deliverableEmbedText` | units |
| `chunkDocument` / `deliverableChunks` — boundaries, overlap, size + count caps, title per passage | units |
| `/api/rag` deliverable retrieval inspection | api |
| `DELETE /api/deliverables/:name` — validation, not-found, traversal neutralised | api (happy path live) |
| Inbound triggers — unknown/disabled token → 404, token shape, list auth | api (guards live) |
| Failed-run accounting — abnormal exits audited with a reason, counted, listed in `/api/runs` | workspaces |
| GitHub issue/PR posting hard-floored — tier, run-auto and policy-allow all fail to cross it | decision |
| `read_issues` stays a safe read — tier may auto-approve, and it is not dragged onto the floor | decision |
| Issue action synonyms — every alias's direction pinned; plural/singular can't cross over | units |
| `modelUnreachable` — all-failed vs. one-success-among-failures, both directions | units |
| `trimVersions` — keep/drop partition the input exactly at every cap boundary | units |
| Purchasing budget — clamp, cent-rounding, non-numeric → 0; `/api/purchases` shape | endpoints |
| Inbox — three queues, `counts.total` can't drift, `latchOk` reported, `seen` monotonic | endpoints |
| `/api/ceo`, `/api/agent-status` — shape + length caps | endpoints |
| HR refusals — `no_hr` / `no_vision` / `no_roles` distinguished, not one 500 | endpoints |
| `hire-plan` `reportsTo` resolution — 2- and 3-way cycles refused, no dangling managerId, 14 cap | endpoints |
| `/api/deliverables/:name/versions` lists from the directory, not just org metadata | versions script |
| Notification webhook — `/api/notify/test`, dead endpoint → 502 + audit row, HTTP 500 ≠ delivered | workspaces |
| `run_failed` push on the failure path (it used to push nothing) | workspaces |
| `/stop` on an unknown run → 404 (it used to confirm `ok:true`) | robustness |
| Goal-linked schedule lifecycle — done disables, re-open resumes, delete removes | api |
| `nextRunAt` on PATCH — settable, clamped to a year, non-numeric → 400 | api |
| `/api/embeddings` status + `/api/embeddings/backfill` + `/api/memory?lexical=` switch | api |
| Approval seam validation (unknown id → 404, bad decision → 400) | api |
| Role introspection `/api/whoami` (operator + readonly) | api |
| Per-run paid cap (`maxPaidUsdPerRun`) | api |
| Steer endpoint routing+auth | api |
| SSRF guard (`fetchUrl`, `apiCall`, incl. DNS-pin refusals) | net |

## Intentionally not auto-tested (accounted for — audit allowlist)

**`run-eval --baseline` measures your CPU as much as the model — run it on an idle machine.** Identical
code and cases, three times on 2026-07-31: `criteria.singleShotRate` **78%** (n=32), **80%** (n=20, p50
9173ms), **100%** (n=60, p50 4227ms). The two low scores were taken while the test suite, the live e2e and
a server restart were competing for the same Ollama; the 100% run had the machine to itself.
`effectiveRate` and `schemaRate` were **100% in all three** — the retry ladder absorbed every first-shot
miss, so no run ever received invalid JSON. **The red gate that stood since 2026-07-31 was load, not a
regression.** The gate now records `n` and `p50ms` in the baseline and flags a p50 gap of ≥1.5× as
non-comparable, so nobody re-baselines over a load artifact or hunts a prompt regression that isn't there.
_These rates are over n = reps × cases (5 reps × 4 cases = 20), so a sample is worth 1/n — 5%, not 20%. I
first wrote the tolerance floor as 1/reps and concluded the 15% gate could never pass; that was wrong, and
the arithmetic is now shown in the output so it can be checked rather than trusted._

**The recall eval's absolute numbers move when the corpus does — read the variant ORDERING.** Memory
recall@3 read 10/12 on 2026-07-30 and 8/12 on 2026-07-31 with the ranker untouched. Every live
`e2e-autonomy` run writes real memory entries against one agent and `agent.memory` keeps only 8, so test
objectives displace real work. The eval now says how much of a drop is that: it checks each label's
target against the corpus first and reports a second **"of the resolvable"** column excluding labels with
nothing to retrieve. On 2026-07-31 exactly **one** of twelve was unresolvable (the checklist work, evicted),
giving 8/11 resolvable — so eviction explains part of the delta and not all of it; the other misses are
against targets that are still present, competing against the test entries the e2e added. The ordering —
hybrid ≫ lexical, weighting vectors no better — was identical both times, and that ordering is what the
eval exists to gate. _Added because a corpus change had read as a ranker regression and cost a real
investigation; and because my first pass at diagnosing it used a loose regex over objectives and
over-counted the unresolvable labels 4×, which the precise check corrected._

**Retrieval quality is measured, not asserted** (`eval/recall-eval.mjs`, needs a live server + embedder):
recall@3 over 12 labelled queries against the live corpus. It exists because a single bad-looking query
is a terrible reason to change a ranker — every "obvious" improvement to the fusion measured the same or
worse. Re-run it before and after any change to `rankByRelevance`, the fusion weights, or the embedding
model, in the same session, and compare the ordering rather than the absolute numbers.

**The browser UI has no automated coverage.** It is syntax-checked by extracting the inline `<script>`
and running `node --check` on it, which catches parse errors but not runtime ones. Anything behavioural
there is verified by loading `http://127.0.0.1:4173/` in a browser and reading the console + network log.
_Done 2026-07-31: the page boots with no JS errors; unauthenticated, it correctly shows `⚠ not signed in`
while keeping `👁 read-only` and `🔒 remote mode` hidden; and the **poller gate holds** — six boot requests
and then silence, where the 2s/7s/12s pollers would otherwise have kept firing (they were measured at
~83 requests/minute before that fix)._

**An AGENT opens a pull request — the test that mattered** (needs a live Latch + model; 2026-07-31, 13
checks via `verify-agent-pr`). A real run: the agent saves a document, proposes `github_pr`, the **hard
floor refuses to auto-approve it at TRUSTED tier**, the in-app seam approves it, Latch branches/commits/
opens the PR, the URL comes back to the agent, and the audit row reads `ok=true, decision="you"`.

**This found two product bugs that 32 Latch-side checks could not**, because those bypassed `fileApproval`:
the PR guard read `run.producedFiles`, which is only merged from `filesWritten` *after* the turn loop —
so `github_pr` was unreachable mid-task; and all three new actions returned `{status, json}` instead of
`json` from `fileApproval`, leaving `approval.id` undefined, which broke the seam **and** the dispatch's
URL poll for issues and comments too. _Lesson: "verified end to end" needs a test that crosses every seam.
Verifying the half you just wrote most carefully is the half least likely to be wrong._

_Harness traps, each of which hid one of the above: there is **no `GET /api/run/:id/events`** — watch a
live run over `/api/run/:id/stream` (SSE replays history on connect); polling the invented route returned a
404 body whose `.events` was undefined, so a healthy run reported zero events and read as "the agent
proposed nothing". Dump the **full event histogram** on failure, not just `propose` types — the `blocked`
events were the answer. And give the agent an allowlist **wider** than the actions under test, or it burns
turns being blocked by the allowlist rather than by the floor._

**GitHub pull requests — the Latch-side executor** (2026-07-31, 13 checks via `verify-gh-pr`). A **denied** approval produces no branch and no PR; an approved one creates the
branch, commits onto it and opens the PR, reporting number, URL and `branch → base`; the branch carries the
`bureau/` prefix; the PR is **filtered out of `read_issues`** (GitHub returns PRs through the issues
endpoint); and a PR with no files refuses with *"needs at least one file to change"* and returns to pending
rather than opening an empty one. _Pass a run number as argv[1] to keep branch names distinct across runs._

_Found by reading real output rather than predicting: the first successful run produced
`bureau/-verification-...`. A leading dash is a **valid** git ref but makes `git checkout -verification…`
parse as a flag, and the whole-string trim looked sufficient until a real title with `[brackets]` went
through it. The sanitiser now trims per segment._

**Artifacts:** `POST /api/github/close` (Latch, operator-only, no approval — the operator *is* the human an
approval exists to reach) closes an issue or PR by number; GitHub closes PRs through the issues endpoint,
so one route covers both. Issue #1 and PRs #2–#4 in `bureauProjects/sandbox` were closed this way.
**Closing never deletes the head branch**, so the `bureau/*` refs remain — that is GitHub's "Automatically
delete head branches" repo setting, and no code here prunes refs.

**GitHub issues — verified end to end** (needs a live Latch + a permitted token; 2026-07-31). Two scripts:
`verify-gh-issues` (17 checks — auth 401 twice, a repo name that sanitises to nothing → 400, both approval
types pending rather than auto-approved, fields surviving sanitisation, label caps, every approval denied
in a `finally` and zero left pending) and `verify-gh-roundtrip` (15 checks against the real
`bureauProjects/sandbox`: an issue really appears with title/body/labels/author, **a create approval that
is DENIED posts nothing**, a comment posts and the count rises, and a wrong issue number fails with
`No issue #999999` and returns the approval to **pending** so it is retryable).

_Three harness bugs cost a false alarm here, all the same root cause — assuming an API shape instead of
checking one. Worth knowing before writing the next one: **GitHub's issues LIST is eventually consistent**
(reading it immediately after a successful create returns an empty array while the issue demonstrably
exists), **`GET /api/approvals/:id` does not exist in Latch** (only PATCH and DELETE — read state via
`/api/state` and find by id, which is what Bureau's own `latchApproval()` does), and a repo configured as
`sandbox` answers as `Sandbox` in URLs, so never compare repo names case-sensitively._

_Artifact: issue #1 in `bureauProjects/sandbox` is a deliberate verification artifact; the round-trip
script comments on it rather than opening more. It can now be closed via `POST /api/github/close` — the
capability the scripts used to say they lacked._

**Version archives — no orphans, nothing unreachable** (needs a live server + model; verified 2026-07-31,
8 checks). Measured on the real corpus first: **116 archive files on disk, 10 listed by any endpoint.**
The DoD checklist is rewritten after every verify pass and is deliberately kept out of `org.deliverables`,
so each rewrite archived a file that was an orphan from birth — one objective had accumulated 19. Now
checklists aren't archived, the list endpoint reads the directory, and all 116 existing files are
reachable again. _One part is NOT covered end-to-end: the on-disk unlink past the 20-version cap needs 21
overwrites of the same document, and no endpoint writes deliverable content (only agents do). The
arithmetic that drives it is unit-tested as `trimVersions` — a keep/drop partition — because an
off-by-one there either leaks files forever or deletes an archive still listed. `BUREAU_VERSION_KEEP`
lowers the cap if someone wants to exercise the unlink for real._

**What Bureau produces when the model is unreachable** (needs a spawned server + a live one; verified
2026-07-31, 9 checks). Scripted because it needs a second Bureau pointed at a dead `LATCH_URL` alongside
a healthy one. Measured before fixing: the run reported verdict `none`, wrote an audited `file_write`
with `ok=true`, and left a draft in the inbox reading _"The team completed the assigned tasks."_ — on a
run that used **zero tokens**. Now it fails with the cause in the audit row and writes nothing. The
control half matters as much: the same guard must not fire on a healthy run, so the script also runs one
against the real model and asserts `verdict != error`, real tokens, and a deliverable.

**The scheduler, observed firing for the first time** (needs a live server + model; verified 2026-07-31,
10 checks). It runs on a 60s timer and had never been seen working — because it *couldn't* be: no API
path could make a schedule due (`PATCH` ignored `nextRunAt`, enabling an overdue schedule pushed it a
cadence forward, and `POST /:id/run` bypasses `tickSchedules` altogether). With `nextRunAt` settable, a
due schedule fires, `lastRunAt` is set and `nextRunAt` advances by one cadence without replaying a
backlog. Scripted rather than in the suite because it must wait out real 60-second ticks.

**Inbound trigger guards end-to-end** (needs a live server + model; verified 2026-07-31, 9 checks): fires
with no credential (by design), an immediate second fire and 5 rapid retries all 429 with `retryAfterMs`,
refusals and the accepted fire both audited, sustained bad-token probing trips the failed-auth damper and
appears in the audit log, and a disabled trigger stays a 404. Firing needs a model, so the enforcement
path is scripted rather than in the server suite.

**Deliverable deletion end-to-end** (needs a live server + embedder; verified 2026-07-31, 16 checks): the
happy path needs a real file on disk, which only an agent run or a direct write produces, so the server
suite covers validation/not-found/traversal and the round-trip is scripted against a throwaway workspace —
archive is byte-identical and readable via the versions endpoint, retrieval stops citing the document,
neighbours untouched, no orphaned pending vectors, exactly one audit row, and a second delete 404s.

**Chunked retrieval end-to-end** (needs a live server + embedder; verified 2026-07-30): a synthetic
12,165-char document with a distinctive fact at char 9296 is retrieved by paraphrase, and the excerpt
returned is the buried passage rather than the document opening. Worth re-running as a script if chunking
changes — the real corpus has no document long enough to exercise it (largest 1489 bytes).

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

**`POST /api/agents/:id/relocate` — only the 404 path is automated.** The success path files a real
`human_verification` approval in Latch, and a suite that leaves pending approvals in the operator's inbox
every run is a suite people learn to work around. The department move and the generated question are
verified by hand. (Everything else on the old "not yet back-filled" list is now covered by
`endpoints.test.mjs` — see the table above.)
