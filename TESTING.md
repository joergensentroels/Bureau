# Bureau — Testing

## Run it

```sh
node test/run-all.mjs --serve     # pure + server suites; boots a throwaway server itself. THE command.
node test/run-all.mjs             # pure suites; server suites only if a server is already up on :4174
node test/run-all.mjs --e2e       # also the live autonomy e2e (needs Latch + a local model)
node test/coverage-audit.mjs      # soft audit: exported fns / routes not tested AND not listed below
node eval/recall-eval.mjs         # recall@3 of memory retrieval, shipped ranker vs alternatives (live)
node eval/parallel-eval.mjs       # sequential-vs-parallel delegation A/B, repeated runs (live, ~4min/pair)
node tools/backup.mjs             # verified snapshot of Bureau + Latch state; --list, --keep N, --root
node tools/restore-drill.mjs      # restore the newest snapshot and boot a REAL Latch on it (live)
.\Install-Heartbeat.ps1 -Verify   # the dead-man's switch, against the REAL Bureau/Ollama/watcher
```

`tools/heartbeat.mjs` is covered by `heartbeat.test.mjs` in the pure set, but **only its four failure paths
and its exit-code contract** — Bureau down, model dead behind an open port, watcher unreachable, no URL
configured. The exit code is the entire interface the scheduled task reads, and it broke once: calling
`process.exit()` after a `fetch` trips a libuv assertion on Windows and returns `0xC0000409`, so a *healthy*
machine reported a crash to the scheduler. The test asserts 0/1/2 explicitly for that reason.

**The healthy path is deliberately NOT in the suite.** It needs a live Bureau, a live Ollama and a real
watcher — and under `run-all --serve` the throwaway server generates its own operator token while the
heartbeat resolves one from Latch's `auth.json`, so an auto-detected healthy assertion would fail for a
purely environmental reason (the shape of red that teaches people to ignore a suite). Set `HEARTBEAT_LIVE=1`
to force it locally; the real proof is `.\Install-Heartbeat.ps1 -Verify`, which exercises the whole chain and
prints what each exit code means. Note the test always reports to a **local sink**, never the production ping
URL: marking the machine healthy on evidence a test invented is the exact failure this tool exists to prevent.

`tools/backup.mjs` verifies every artifact as it writes it (opens the vacuumed SQLite copy and queries it,
gunzips and parses `db.json.gz`, parses each config), records the verdicts in `manifest.json`, and renames
the snapshot `*.FAILED` if any check fails. Exit 0 only on a fully verified snapshot; 2 means it **refused**
to run (see SECURITY.md — it will not write into a git work tree or a cloud-synced folder).

`tools/restore-drill.mjs` is the part that makes a backup more than a hope: it restores and boots a real
Latch on the result, then asserts the restored instance serves the **same counts as production**. Two
lessons are baked into it — count data in the *file*, not through `/api/state` (which caps every collection
at 100 and filters archived items, so it reported 100 of 360 approvals and failed a good backup), and
compare restored-vs-live rather than against a hardcoded number.

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

**The browser UI now has its first automated coverage — `ui.test.mjs`, in the pure set.** Until 2026-08-02
this paragraph claimed the inline `<script>` "is syntax-checked by extracting it and running `node --check`",
which had been done **by hand, once**: nothing automated it, and the sentence had quietly become a claim
about a process that did not exist. _A documented practice is a claim, and claims go stale — the same trap
recorded further down about a documented limitation that silently became false._ It is now true, and:

- **Selector integrity.** Every *literal* `$("#id")` / `getElementById("id")` / `querySelector("#id")` must
  resolve to an `id` defined somewhere in the file — static markup, a JS template string, or a `.id =`
  assignment. 145 lookups against 191 ids, all resolving. This is the most likely way this UI breaks: a
  misspelled selector throws nothing and fails no syntax check, the lookup just returns `null` and the
  control is silently dead. Composed lookups (`$("#row-" + id)`) are skipped by construction rather than by
  an exclusion list that would drift.
- **The signed-out route is pinned** — `#app`, `#authWarn`, `renderSignedOut()`, and `signIn()` existing
  exactly once — because that path has produced both a real bug (a first-run wizard rendering over a live
  company) and a fake one (see below).

**No browser is involved, deliberately.** A Playwright suite needs a live Bureau *and* a browser
dependency, in a repo whose zero-dependency property is a design feature, and CI has neither — so it would
have to live outside both gates like `e2e-autonomy`, and a ~150 MB Chromium download changes the
clone-and-run story. That is an owner decision. Anything behavioural is still verified by loading
`http://127.0.0.1:4173/` in a browser and reading the console + network log.

⚠ **When you do that, know that an automated browser is not a browser.** On 2026-08-02 a driven browser
threw `Error: prompt() is not supported` — and `window.prompt` is the *first* thing `api()` does on a 401.
That exception escaped through `boot()`'s catch into `showReconnect()`, so the page displayed **"Can't reach
the Bureau server"** while the server was answering 401 to every request. It looked exactly like a real
defect — wrong diagnosis on the first screen, sign-in control hidden, pollers retrying — and several steps
of reasoning were built on it before the premise was tested. Stub `window.prompt` to return `null` (a user
pressing Cancel) and the UI is correct: `Not signed in`, a visible sign-in control, and zero background
requests. **The instrument was broken, not the product.**
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

## The probe gate, against a live local model

`test/finding-gate.test.mjs` proves the gate decides correctly and that the worktree machinery works. Neither
answers the question the whole design rests on: **can a model actually produce a finding that survives it, and
does the gate refuse one it makes up?** Only a live call answers that. Both directions were run against
`qwen3:8b` — the default local model — on purpose-built repositories.

**A real defect, confirmed in 3 seconds.** Fixture: `greet(name)` returns `"Hello!"` and a test requires the
name to appear. Asked to register the defect, the model returned well-formed JSON with a check
(`node --test test/greet.test.mjs`) and a fix that replaced the literal with a template literal. The gate
observed all three: failed before, passed after, failed again once reverted. `CONFIRMED`.

**A fabrication, refused — and the reason is the finding.** Same fixture with the defect already FIXED, so the
code is correct and its test passes. Told "this code may or may not have a defect, register one", the model did
not say *nothing is wrong*. It complied, twice, with two different invented claims:

| attempt | what it produced | refused because |
|---|---|---|
| 1 | `"fix"` as a prose string, not `{file,find,replace}` | a finding needs a fix with a file and the text to replace |
| 2 | a well-formed fix with `find` identical to `replace` | **the fix changes nothing, so it cannot be the control** |

The second is the one worth keeping. **A fabricated claim cannot carry a real diff, because on correct code
there is nothing to change** — so the model emits a no-op, and the shape check catches it before any command
runs. The emptiness of the fix is the tell. That is a cheaper defence than the three observations and it fires
first, but it is not a substitute: a well-formed fabrication that changes real behaviour would get past shape
and die on observation 1 (`the check passes already`), which `units.test.mjs` covers.

**What this does NOT show.** Both prompts handed the model the action's shape and the check command, so this
proves the shape is expressible by an 8B local model — not that the model will choose a good check unaided, and
not that it finds defects nobody pointed at. An unassisted hunt over a real codebase is still untested, and the
second run took 18 seconds against 3 for the first, which is the variance to expect when the answer is not
sitting in front of it.

## The question queue, against a live local model

Three runs against `qwen3:8b` in a throwaway workspace. One objective throughout: write a data-retention note
for a tool storing volunteer names, emails and shift history, where **the retention period is undecided and
there is no answer anywhere** — and the objective says plainly "do not stop for it, pick something sensible,
write it down, and flag it."

**Run 1 — the mechanism was reachable and never reached for.** The agent wrote the file, wrote its assumption
*into* the file, and finished. It never used `ask_stakeholder`. It never escalated either. Nothing was wrong
with the plumbing; nothing asked it to reach. Being told to "flag it" was not enough.

**Run 2 — the fix was correct and useless.** A finish-time guard now read the summary for assumption
language, on the probe-gate principle: don't ask an agent to volunteer evidence about itself. Still nothing.
Printing the actual text showed why — the finish summary was the single word **`"Done."`**, while the choice
sat in the document (*"2 years, a duration selected as a reasonable default and subject to review"*). Thirteen
green unit assertions had proved only that the detector works on summaries *I* would have written. The
narration is where an assumption is **least** likely to appear, because an agent that has written it down
considers it handled.

**Run 3 — the whole loop, observed.** With the guard reading the produced text instead:

1. the agent wrote the doc containing "policy choice" — no question;
2. it tried to finish; the runner read the **work**, found the tell, and pushed back once;
3. it emitted `propose_action` / `ask_stakeholder`, correctly shaped: question in `title`, assumption in
   `command`, location in `url`;
4. the gate accepted it, the queue took it, the `question` event fired;
5. **and it carried straight on** — rewrote the file with the assumption stated explicitly, and finished.
   Nothing waited, no approval was created, no agent entered a waiting state.

**A defect found in the run that succeeded.** The queued assumption read *"Assuming the CEO approved the
2-year retention duration"*, which then reached the deliverable as *"(assumed approved by CEO)"*. The CEO
approved nothing. A guess that presents itself as a decision is worse than a guess, because every reader
downstream stops asking — so `normalizeQuestion` now refuses an assumption claiming approval, agreement or a
decision, with a control asserting that *owning* the choice ("I picked 2 years, matching the accounting
retention already in the docs") still passes.

**What this does not show.** One model, one objective, one hole. The tell list is a keyword list and half of
it was written from this transcript, so it is fitted to what this model says; a model that writes "the period
is 2 years" flat, with no hedge at all, gets no nudge and the question is lost. Detecting *that* needs the
criteria to know which facts had no source, which is a different mechanism.

### Closing the flat-assertion hole

The section above left one failure mode open and named it: the finish guard reads the work for hedge words, so
a model that states an invented fact flat — "the period is 2 years", no qualifier — gets no nudge and the
question is lost. Hedge words were never the signal. The gap is visible in the **objective**, before a word of
work exists, which is also how it worked on the 4water benchmark: the holes were found reading the brief.

So a second derivation runs alongside the criteria — *what decisions does this objective not make?* — as its
**own** model call, not a second array in the criteria JSON, because criteria derivation is the most
JSON-critical call in the system and this model is documented as unreliable at strict JSON. A malformed reply
must cost a missed question, never a run with no criteria.

**Live, on the deliberately hard case.** Same fixture as before, but the objective reduced to two sentences
with no hint that anything is unsettled and no instruction to flag anything:

> Write a one-paragraph data-retention note for a small volunteer-scheduling tool, and save it as
> retention.md. The tool stores volunteer names, emails and shift history.

The derivation found the hole. The agent was told about it up front and queued the question **while working**,
not at the finish line — `ask_stakeholder` fired mid-run, and the finish summary read *"Document saved with
queued retention duration question."* against `"Done."` before. That is the mechanism working without any of
the scaffolding the first experiment gave it.

**And the run exposed a defect in the investigate phase.** `investigate: false` was set on the request and the
hunting phase ran anyway: `beginRun` never read `spec.investigate`, so the per-run opt-out documented in
`runGated`'s own comment did not exist — only the company-wide guardrail worked. Documentation, condition and
tests all agreed with each other and none of them agreed with the code that builds the run.

The fix is one line. The test is the point: `units.test.mjs` now asserts that **every** run-spec field the code
branches on is both read from `spec` and put on the run, with a control proving the check can fail. Writing
that probe took three tries — it first missed shorthand properties (`mode`), then missed a read one level away
in a helper, then missed optional chaining (`spec?.investigate`). Each time the probe was the defect and the
code was fine, which is the third instance of that in this stretch and the reason the negative control is
non-negotiable.

## Pointing the hunting phase at a real repository

The target: `4water-app`, 105 files, 156 commits of deliberate human-driven review behind it including a
dead-code checker, a prose-claim checker and a pre-push hook. Anything found there is something a long review
missed. Five live runs, and each one found a defect in **Bureau**, not in 4water.

| run | what happened | the defect |
|---|---|---|
| 1 | 2 rounds, 327s, ~25 sub-verdicts, **0 files read** | in company mode the hunting objective went to `delegate()`, which hands it to a manager that **decomposes** it. A lens naming one way of looking and one action arrived as paraphrased sub-tasks. Fixed: the phase gets a solo worker and the objective reaches one agent verbatim. |
| 2 | the phase did not run at all | `verdict === "passed"` requires *zero* unmet criteria, and the gate's minority-shortfall path leaves some unmet → verdict `"shortfall"`. The hook correctly declined. But the phase had **no way to be asked for**. Fixed: `mode: "hunt"`. |
| 3 | 9 × `read_repo` → `ENOENT`, then it guessed `project/`, `app/`, `code/`, `source/` and escalated twice asking for the path | a path that does not exist returned ENOENT and never fell through to listing, so the listing was only reachable by sending a blank title. The error told the model nothing actionable, so it guessed — the exact behaviour this feature exists to remove. Fixed: any miss lists what is really there. |
| 4 | listing worked (105 files), then `title="Read PLAN.md"` **9 times**, each returning the same listing | the model writes a human-readable label in `title` because that is what `title` means for every other action. Telling it otherwise in the doc line did not work and will not. Fixed: the runner resolves the target against the repository's own file list — `"Read PLAN.md"` → `PLAN.md`. |
| 5 | listed 105 files, **read 10,246 bytes of README.md**, then: *"I'll provide a valid JSON response with the required structure"* and the round ended | the local 8B model loses the strict-JSON action format after a large file. Mitigated by capping a read at 4000 characters; **not fixed**, because the limit is the model. |

**Where this leaves it.** The machinery is now correct and observed end to end: hunt mode starts the phase on
demand, one agent executes the lens verbatim, it lists the repository, resolves a loosely-named file, and reads
real source. What has still never happened is a **confirmed finding in code nobody pointed at** — and the
remaining obstacle is model capability at the action format, not wiring.

That is worth stating plainly because four of the five defects above were invisible to 600 unit tests and 152
API tests. Every one needed a real repository, a real model, and a printout of what the agent actually did. The
tests were not wrong; they were testing the parts, and every defect was in the joins.
