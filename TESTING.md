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
| 5 | listed 105 files, **read 10,246 bytes of README.md**, then: *"I'll provide a valid JSON response with the required structure"* and the round ended | **first written up wrong.** I recorded this as the model losing the strict-JSON action format. It did not: the `say` event fired for that turn, and `say` only fires after the parse succeeds. The JSON was valid. The model read 10kB, had nothing to do with it, and finished. The real gap was that a read result ended with a *constraint* and no direction, while the lens instruction had been given once, a listing and 4000 characters earlier. Fixed: the read result now repeats the lens and states the three ways to proceed, one of which is "this lens shows nothing here". Reads are also capped at 4000 characters. |

**Where this leaves it.** The machinery is now correct and observed end to end: hunt mode starts the phase on
demand, one agent executes the lens verbatim, it lists the repository, resolves a loosely-named file, and reads
real source. What has still never happened is a **confirmed finding in code nobody pointed at** — and the
remaining obstacle is model capability at the action format, not wiring.

That is worth stating plainly because four of the five defects above were invisible to 600 unit tests and 152
API tests. Every one needed a real repository, a real model, and a printout of what the agent actually did. The
tests were not wrong; they were testing the parts, and every defect was in the joins.

### Run six: a real review loop, and the model refuting itself

With the read result repeating the lens, the same hunt behaved completely differently — and this is the run worth
reading:

1. listed the repository (105 files);
2. read `src/audit.mjs`;
3. formed a hypothesis: *"/admin/invite/revoke is exempt from audit logging but should be audited as it changes
   another person's access"*;
4. read `test/audit.test.mjs` to check it, and noted the test flags POST routes in neither `AUDITED` nor
   `NOT_AUDITED`;
5. re-read `src/audit.mjs`;
6. **refuted itself**: *"already in AUDITED as 'an invitation was withdrawn' — it meets…"*

Hypothesis → check the test → check the source → withdraw the claim. That is the loop the lens exists to produce,
and the gate never had to refuse anything because the agent got there first. Registering nothing was the correct
outcome: `/admin/invite/revoke` **is** audited.

It also exposed a cost defect. The agent proposed `web_search` twice — reaching for the only verifying-shaped
tool it could see, when the answer was two files away — and each call spent the full 150-second
`waitForExecution` deadline discovering there is no worker executor. **300 of the round's 349 seconds went on
proving the same absence twice.** A timeout is now remembered for ten minutes and re-probed for 8 seconds instead
of 150, self-healing the moment a worker returns: 300s → 158s on this exact run. And a search that fails during a
hunt now says the repository is where a claim about code gets checked, rather than suggesting `web_research`.

### Runs seven and eight: the read cap manufactured a false finding

A five-round hunt was cut off by its own 15-minute client limit after two rounds, and both rounds found defects
in Bureau.

**Round 1 lost 600 of its 776 seconds to the hard floor working correctly.** The agent proposed `shell` to run
`npm test` — a reasonable thing to want — and `shell` always needs the CEO, so an approval was filed in Latch and
the run waited the full ten-minute deadline for a human who was not watching. The floor is right; the wait was
pure loss, because `register_finding`'s `check` field runs exactly those commands under the runner's own
allowlist with no approval at all. A hard-floored action during an unattended hunting round is now redirected
there instantly. Nothing new becomes runnable — the check allowlist is narrower than `shell` has ever been.

**Round 2 produced a substantive claim, and it was false because of a cap I had just added.** The sibling-path
lens read `src/auth.mjs` and reported: *"the 'invite' provider in PROVIDERS is not handled in auth.mjs,
indicating a missing sibling implementation."* Checked by hand: **false.** The invite path is fully handled at
lines 273–304 and explicitly documented at line 220. But `auth.mjs` is 20,279 bytes and reads had just been
capped at 4,000 to keep the small model coherent — so the agent saw `PROVIDERS = ["dev","oidc","invite"]` on line
6, saw two of the three handled inside the first 4kB, and never saw the third. **It reasoned correctly from
evidence I truncated.**

The general rule, which nothing in the read result had stated: **a truncated read is evidence of PRESENCE and
never of ABSENCE.** Two fixes. The read message now says so, every time it truncates. And there is now an
instrument a prefix cap cannot defeat — a term in `command` greps the whole file (or the whole repository) and
returns every matching line with its number, capped by *matches* rather than by position. On the real file it
returns 17 hits for `invite`, including line 220 and everything past the cap, so it would have refuted the claim
in one turn. An empty search result *is* evidence of absence, and the message says that too.

Worth noting what did not go wrong: the gate would have refused that claim anyway, because no check command
could have been made to fail. The false hypothesis cost a round, not a corrupted register.

### Run nine: the gate could never run `npm test` on Windows

With the harness given a real idle timeout (an AbortController reset per chunk — the old `LIMIT` check only ran
*after* an event arrived, so a silent stream parked it forever and I went looking for a server-side stall that
was not there), a three-round hunt surfaced three more defects.

**`spawn EINVAL` — two of the four allowlisted check shapes were impossible.** The agent proposed a finding with
`check: "npm test"` and the gate answered *"verification itself failed: spawn EINVAL"*, twice. Reproduced
directly: `execFile("npm.cmd", …)` throws **synchronously** on Node 24 Windows (the `.cmd` spawn restriction from
CVE-2024-27980), so the promise wrapper never settled either. `npm test` and `npm run <script>` have been
unusable since the gate was written. **Eighteen green gate assertions said nothing about it, because every
fixture used `node --test`.** npm now runs as `node <npm-cli.js> …` — same program, no shell, no `.cmd` — and
`run1` catches a synchronous throw. Verified against 4water: `npm test` inside a throwaway worktree,
`{ok: true}`, real test output.

The instrument: the check allowlist is the gate's **contract**, and a contract with an untested branch is a
guess. `finding-gate.test.mjs` now proves a finding end-to-end through `npm test` as well, with the control that
npm reporting a *passing* check refuses the claim.

**My anti-false-absence instrument manufactured a false absence.** `title="Read src/db.mjs"`,
`command="src/db.mjs"` produced `SEARCH src/db.mjs for "src/db.mjs" → 0 matches`, and the agent immediately said
*"the search has confirmed absence"*. The model puts the path in `command` at least as often as in `title`, so a
term that resolves to a real file is now treated as a path, not a search string — and either field may carry it.

**A finish wrapped in `propose_action` burned seven turns.** The model emitted `actionType: "finish"`, which
matched no branch, so it fell through the dispatch and repeated itself seven times in one round. Now normalized
to the finish it plainly is.

And a fixture bug caught by checking the probe: `node --test <dir>` exits **1** on a plain script with no
`test()` calls under Node 24, so the fixture's own `test` script had to name the file. Left unnoticed it would
have reported a false failure *of the gate*.

### The gate refusing a real false claim, on evidence

Run nine's agent claimed: *"test/auth.test.mjs imports hasRole from src/auth.mjs, but this function is not
present."* Both halves are false — `hasRole` is exported at `src/auth.mjs:325` and the test never imports it. It
is the same truncation artifact as the earlier 'invite' claim: line 325 is far past the 4,000-character read cap.

That claim was replayed through the gate, made well-formed first so the **evidence** rule decided rather than the
shape rule:

```
shape: accepted — so the evidence rule is what decides
verdict: REFUSED
reason : the check passes already, so it does not see the defect described
observations: {"before":true}
```

Before the npm fix the same claim returned *"verification itself failed: spawn EINVAL"* — an infrastructure error
dressed as a refusal, which is the worst possible outcome because it looks like judgement. Now it is refused for
the correct reason, and the reason is legible.

**With the control that makes it mean something.** A refusal proves nothing if the check can only ever pass, so
the same command was run against a deliberately broken tree: renaming the `hasRole` export makes `npm test`
**fail**, and reverting makes it **pass** again. So `npm test` discriminates on this repository, and the refusal
above is a judgement rather than a check that is blind.

Caveat worth stating: this is a *replayed* claim. The model produced it live; the well-formed version and the
gate call were mine. It shows the gate decides correctly on a real false claim against a real repository — not
that an unassisted agent reaches that outcome on its own.

Measured while doing this, since it bears on the round budget: a check in a fresh worktree costs under a second
for `node --test <file>` and about 6 seconds for `npm test`. One earlier script took far longer for reasons I
could not pin down — the import and the check commands were both ruled out by measurement, so it is recorded as
unexplained rather than attributed.

### The cap that caused both false claims, fixed structurally

Every false claim in this work came from the same place: a 4,000-character prefix of a 20,279-byte file, and an
agent concluding that what it could not see was not there. `"the 'invite' provider is not handled"`;
`"hasRole is not defined in auth.mjs"`. Both wrong, both from the same file, both refutable from the part that was
cut off.

I answered that first with a **warning** — *"a truncated read cannot show absence"* — and the model ignored it
twice. That is the correct lesson about warnings, so the fix is now structural: **the body is capped, the outline
never is.** A read that truncates now carries a complete list of every declaration in the whole file, with line
numbers, bounded by symbol count rather than by position. On the real file:

```
auth.mjs: 339 lines, 22 declarations
  hasRole       line 325  export const hasRole = (db, personId, role) => {
  inviteStatus  line 273  export function inviteStatus(db, token, …
  redeemInvite  line 281  export function redeemInvite(db, token, …
  PROVIDERS     line 6    export const PROVIDERS = ["dev", "oidc", "invite"];
  notARealSymbol           correctly absent
```

Both false claims die at the source, and the message states the asymmetry in both directions: not in the list
means really not declared here; in the list means it exists even though you cannot see its body.

The outline is deliberately syntactic and language-loose — a missed exotic declaration costs one line of a
listing, whereas parsing properly would cost a dependency and this project has none. Controls in the suite: a
symbol that is not declared is absent from it, comment lines are not mistaken for declarations, and an absurdly
long line (a minified bundle is one enormous line) is skipped rather than quoted back.

### Run ten: the outline worked, and silence was the next defect

With the outline in place the same hunt behaved differently in the way that matters. Round 1 read `src/audit.mjs`
(12,746 bytes, body capped) and concluded: *"The current audit rules match the described behavior. No defects
found in this partial view."* **It named the partial view instead of claiming absence.** That is the first time an
agent handled a truncated read correctly, and it is the whole point of the outline.

Round 2 then found a new defect. After reading `src/auth.mjs` the agent emitted **nine consecutive turns** of
`speak: "…"`, `actionType: "other"`, every field empty. Two causes, both silence:

- **`"other"` was advertised in the actionType enum the system prompt hands out, and nothing implements it.** It
  fell off the end of the dispatch chain — no result, no error, no feedback — even when it carried content. The
  prompt was offering an action that does nothing. Removed; `note` is the implemented catch-all.
- **Nothing noticed an action carrying no content at all**, so there was no reason for the model to stop.

A wasted turn the model cannot detect is a turn it will repeat until the cap, and it did — nine times. Both are
now refused with a reason, and three in a row ends the round with `gaveUp: true` rather than reading as a clean
dry round, which would have been the more damaging outcome: a round that spent its whole budget on empty JSON and
reported "nothing found" is indistinguishable from a round that genuinely looked.

## The root cause of every model-side failure: a 4,096-token context window

Fourteen runs blamed the model for degrading after a large read. It was measurable, and it was not the model.

**Ollama's default context window is 4,096 tokens, and Bureau sets `num_ctx` nowhere.** Probed directly, with the
rule placed at the very start of the prompt so truncation would remove it:

| prompt | tokens Ollama processed | obeys the rule at the top |
|---|---|---|
| 0.2 kB | 65 | YES |
| 17 kB | 3,425 | YES |
| 17 kB, `num_ctx: 16384` | 3,425 | YES |
| **50 kB, default** | **2,050** (of ~9,865) | **no** — answered with a line of the filler |
| 50 kB, `num_ctx: 32768` | 9,865 | YES |

Past the window the prompt is clipped **from the front**, which is where the system message lives. That is exactly
the observed behaviour: `actionType: "other"` with every field empty (the action list is gone), *"I'll provide a
valid JSON response with the required structure"* (it knows it owes JSON and has lost the schema), and content
drawn from the wrong part of the prompt.

A hunting turn was measured at **16,882 characters ≈ 4,220 tokens before any reasoning** — over the limit on turn
one, and every read pushes it further.

**Why it cannot be fixed in the request.** Latch reaches the local model through the OpenAI-compatible
`/chat/completions` endpoint, which has no `num_ctx` field. Raising the window means a machine change —
`OLLAMA_CONTEXT_LENGTH` on the Ollama service, or a derived model with `PARAMETER num_ctx` — and this GPU is at
**13,716 of 16,303 MiB used, 2,280 free**, so a larger KV cache is not obviously affordable. That is the
operator's decision, not one to take unilaterally on a service that boots as a scheduled task.

**What was free.** A review round can only use a handful of actions, so it is no longer shown the rest: the
hunting system prompt drops `file_write`, `purchase`, `github_*` and the others, and says in words that it is a
review phase. 8,613 → 6,338 characters, about 570 tokens back, with controls asserting construction is untouched.
It is a mitigation and not a fix — the turn still begins near the limit — but it is the half that does not require
someone to trade VRAM.

Also found while measuring: **`note` is implemented and enumerated but was never described to the agent** — the
exact inverse of the `other` defect. In a review round it is the right action for "I looked here, this is what I
checked, nothing to report", which is the answer most rounds should give. Now documented.

## Before a new API key can help: the paying agent needs a budget

Every hunt in this work ran on the local model, and a new key alone would **not** have changed that. A paid turn
needs four things at once:

```js
const canUsePaid = () => run.paidAvailable && !run.hush && budgetUsd > 0 && (startPaidSpent + paidThisRun) < budgetUsd
```

The agents created for those hunt runs had `budgetUsd: 0`, so they were local-only regardless of the provider —
and **from the outside an unfunded agent is indistinguishable from a missing key.** Nothing in the run output said
which it was; establishing it meant reading four conditions across three files.

Now every agent task announces its tier before the first model call, with the reason it is not the other one, and
the four causes are worded distinctly: no provider configured / the paying agent has no budget / the run is hush /
the budget is spent. A local **review** round additionally gets told the local window is 4,096 tokens and a long
round will be clipped — the two facts stated where they matter together, and nowhere else.

**So the checklist when a key goes in** (the key itself is the operator's to enter — it lives in the gitignored
`openclaw-command-center/data/llm-provider.json` under `fallback.apiKey`, and nothing here reads or prints it):

1. put the key in;
2. **give the hunting agent a budget** — without it the run is silently local;
3. start a hunt and read the `tier` event: it says `paid` with the model, or exactly which of the four conditions
   failed;
4. the configured fallback is `kimi-k2.6`, whose window is far larger than 4,096, so the clipping that explains
   every model-side failure in this document does not apply to those turns.

Currently configured (checked without reading any key material): primary is the local Ollama through its
**OpenAI-compatible** endpoint `http://127.0.0.1:11434/v1` — which is precisely why `num_ctx` cannot be sent — and
the fallback is Moonshot `kimi-k2.6`.

## Looking at the UI: `node test/run-all.mjs --ui`

Two panels and about a dozen feed renderers were added to `public/index.html` during this work and **none of them
were ever opened in a browser.** They were verified by extracting the page's `<script>` and compiling it, plus
`ui.test.mjs` asserting against the source text. That is a check on syntax and on strings, not on whether the page
renders — and it was skipped on the stated grounds that "the authed UI needs the operator token, and putting it in
a browser means putting it in the clear".

That reason did not survive contact with the codebase. `bootServer()` in `run-all.mjs` has always generated its
**own disposable token** (`"test_" + randomBytes(18)`) and the API suites have used it all along. The parallel test
setup already existed; nobody had pointed a browser at it.

`--ui` closes that: it runs the suites, then holds the throwaway server open and prints the URL and the run-only
token. One command instead of an assembly job.

```bash
node test/run-all.mjs --ui
```

**Deliberately not a no-auth mode.** An auth-bypass flag is exactly the kind of switch that escapes into
production, and this project has already found three switches that read as present and were never wired. A
disposable credential keeps the boundary enforced and makes the secret worthless instead.

Verified through the browser once the harness existed: the **Lenses** panel renders all 8 entries with their full
instruction text, an on/off toggle each, "never run here yet", and the header line *"0 of 8 tried so far…"*; **Open
questions** renders its empty state with the `+ Decision` and `Refresh` controls. Zero console errors after unlock
(the only ones are a pre-unlock 401 on `/api/org`, which is the unlock flow, and a favicon 404).

One thing only a look would show: each lens card prints its **entire** instruction, several over 200 characters, so
eight of them make a very tall panel. Left as observed rather than changed — it is a presentation call.

## The third gate: an excuse is a claim

Bureau refuses an unproven **finding** (the probe gate) and an unstated **assumption** (the question queue). The
missing third was an unexamined **exemption** — a reason for *not* checking something. It is the least likely claim
to get a control, because its entire function is to close the question.

It comes from a real failure in this work, caught by the operator rather than by any instrument. Two panels and
about a dozen feed renderers went into `public/index.html` and **none were opened in a browser**, on the stated
grounds that *"the authed UI needs the operator token, and putting it in a browser means putting it in the clear."*
Said once, never revisited, and it silently licensed every subsequent skip across roughly ten commits. It was
false: `bootServer()` in this repo's own `test/run-all.mjs` had always minted a **disposable** token, and the API
suites had been using it the whole time. The escape hatch was in the same directory as the excuse.

**`declined_check`** requires three fields and refuses without any of them: what was not checked, why, and **what
would have to be true for it to become possible**. That third field is what makes the reason testable at all.

Then the runner tries to **falsify it**. An excuse says "the operator token", not `OPERATOR_TOKEN`, so noun phrases
are translated into identifier spellings — `operator_token`, `OPERATOR_TOKEN`, `operatorToken` — alongside anything
already shaped like an identifier, a flag or a path, and each is searched for in the repository. Against the real
excuse:

```
MY EXCUSE (should be contradicted)  3 hits  operator_token@eval/parallel-eval.mjs:43  OPERATOR_TOKEN@…  operatorToken@Install-Autostart.ps1:197
a real blocker (should NOT be)      1 hit   paidProvider@eval/run-eval.mjs:36
"the GPU has no room left"          0 hits
```

**Bare English words are deliberately not candidates.** Measured first: with them, "operator", "provider" and
"replace" each hit anything, so a genuinely blocking excuse looked contradicted three times over — and a gate that
fires on everything is a gate that gets routed around.

The residual false-positive rate is real (one noisy hit above), so the gate **hands the evidence back once and then
accepts a re-declaration.** It makes the agent look at the counter-evidence; it does not overrule the conclusion.
Same philosophy as the hard floor: the decision stays where it belongs, the floor only guarantees the question gets
asked.

Recorded on the company at `GET /api/declined-checks`, because a skipped check mentioned only in a run summary is
gone by the next commit — which is exactly how this one survived.

**No UI panel in that commit, on purpose.** The lesson that produced this register was shipping UI unlooked-at, so
the panel belongs in a commit that also runs `node test/run-all.mjs --ui` and looks at it.

## The refuter, and the two jobs it was given

A refute agent was considered against the ~15 defects this work actually found. It would have caught **two**:
the unlooked-at UI (*"you say tests cover it; tests don't render a page"*) and possibly the false-absence claim
from a truncated read. It would have caught **none** of `spawn EINVAL`, the 4,096-token window, the ENOENT
dead-end, the unimplemented `other`, the amnesiac lens register, or the unplumbed `investigate:false` — those are
facts about the world, and no amount of reasoning surfaces them. On the context window it would have been *worse
than nothing*: clipped identically, and confidently agreeing.

So it was scoped to the two questions where **no mechanical control is possible**:

**1. Sufficiency.** `verifyFinding` proves a check *discriminates* — failed, passed with the fix, failed again on
revert. It does not prove the check tests the property the claim names. That is the proxy problem, and it is
measured: on the 4water build **5 of 7 derived audits asserted a proxy** — every one green, on real input,
computing correctly, answering a weaker question. `fail → pass → fail` cannot see it.

**2. A surviving excuse.** When the declined-check falsifier returns zero hits, that means nothing was *named* —
not that the reason is sound. "The GPU has no room" greps to nothing whether it was measured or guessed.

**It produces a caveat, never a verdict**, and the finding is recorded *before* the reviewer is asked, so it
cannot overturn an observation. It runs on the same model as the agent, and the stored text says so —
`"(same-model review, so weak evidence)"` — because a same-model refuter that could overrule an observation
manufactures the appearance of independent confirmation.

**Tried live, and the two jobs are not equally good on this model:**

- *Excuse* — genuinely useful, and not parroted: *"The reason is inferred, not measured; the cheapest check would
  be measuring free VRAM. A weaker check could involve testing a smaller context window first."* That is exactly
  the push toward measurement that was wanted.
- *Sufficiency* — structurally right, shallow: it answered in the correct shape (*"this would satisfy the test's
  condition while the claimed defect remains unaddressed"*) but reused the example from the prompt rather than
  reasoning about the specific check. Pattern-matching more than analysis. Worth having; not worth trusting.

**A defect written and removed inside this commit, worth recording.** The first version ended `catch { return ""; }`
— so a reviewer that could not be reached was **indistinguishable from one that had nothing to say.** A check that
cannot run must never read as a clean bill of health; that is the exact class this whole register exists to remove,
and it reappeared in the mechanism built to prevent it. It now returns `"(the reviewer could not be reached: … —
this is NOT a clean review)"`. Found because a probe returned two empty strings and the empties were investigated
rather than accepted.

## The paid tier, and two defects it exposed in my own tools

Kimi (`kimi-k2.6`) on a funded agent, hunting 4water. Cost: **$0.163** for one round, **$0.287** for two. The
behaviour is not a better version of the local model's — it is a different activity.

Round 1, lens `spec-descriptive` (*"start where the spec merely DESCRIBES the old system"*): it listed the repo,
read `PLAN.md` (38 kB), then ran nine targeted searches — `"spreadsheet"`, `"In the spreadsheet"`, `"used to"`,
`" was "`, `"Imported ActiveCph"`, `"spec Q"`. Searching for past-tense prose is exactly how you find an
observational requirement. qwen3 never did anything of the kind.

Round 2, lens `what-would-it-accept`: it went after the audit tests themselves — reading `csrf-audit.test.mjs` and
`authz-audit.test.mjs`, then checking whether the route-matching in those audits could miss routes. That is the
lens working precisely as written.

**And it found two defects in my search tool, both producing false absence.**

```
SEARCH … "assert\.ok\(|assert\.equal\(|assert\.match\("   -> 0
SEARCH … "assert\.|for.*body"                             -> 0
SEARCH … "assert"                                         -> 16   ← plain literal
```

The model sends **regexes**, because every search tool it has ever seen takes them. `searchRepoFiles` matched
literal substrings, so every pattern returned zero and the agent read absence — a false-absence machine inside the
instrument built to prevent false absence. The literal `"assert"` returning 16 is what proves the zeros were the
tool. And `read_repo "test/"` with a term reported *"SEARCH the whole repository"*: the directory did not resolve
to a file, so the scope silently widened from one directory to everything.

Both fixed. The search now reads a pattern when the term plainly is one (alternation, `.*`, character classes),
**reports which mode it used**, refuses a pattern that will not compile or that could backtrack catastrophically
(a model-supplied regex runs in this process and Node has no regex timeout), and an empty result no longer claims
absolute absence — only absence *of that spelling*. An unresolved path is stated rather than quietly widened.
Replayed against the exact queries from the run: 0 → 9 hits, 0 → 14 hits, and `gate\(|postGate\(` still 0, which
was always correct.

Still no confirmed finding. But for the first time the reason is not "the mechanism misled it" — the model used
every instrument correctly, and two of them lied to it.

## Two more rounds, two more defects — and the worst kind

With the search reading patterns, `maxTurns` raised to 20 and the turn-budget warning in place, the round finally
**ended with a conclusion instead of mid-sentence**: *"This lens revealed no dangerous defaults. Every bound I
inspected is explicit and safe: rate limits use fixed constants, retention floors at 1, outbound…"*

That conclusion was **false**, and not because the model was careless:

```
-> read_repo "" cmd="Infinity"   ->   read Infinity/ -> 106 files
-> read_repo "" cmd="skip"       ->   read skip/     -> 106 files
-> read_repo "" cmd="= null"     ->   read = null/   -> 106 files
```

Seven searches in that round — `Infinity`, `-1`, `skip`, `timeout`, `limit`, `= null`, `= true` — **silently became
directory listings**. `want` fell back to `next.command` when the title was blank, so `want` *became* the search
term, `term !== want` was false, the search branch was skipped, and it fell through to listing. The agent reported
that it had inspected every bound, having run none of those searches.

This is the worst of the three dispatch defects. The first two produced **zeros**, which look like absence. This
one produced a **confident, specific, wrong conclusion** — and nothing in the transcript marks it as different from
a real one.

Fixed: `title` is the path, `command` is the term, and they are no longer conflated. A command that names a real
file is still honoured as a path, which `resolveRepoTarget` already handled.

**The turn-budget fix worked.** Counted from the previous run: exactly 12 actions with `maxTurns: 12`, ending one
search into "how does `rolesOf` handle a missing personId". Zero findings *and* zero refused claims — it never made
a claim, because the round ran out underneath it and nothing said so. Now the round prompt states the budget up
front, and a single warning fires with two actions left offering the two things still possible: register, or say
plainly what the lens showed. Silent during construction, where running out just means a shorter document.

Cumulative paid spend across five runs, nine rounds: **$1.78**.

## The forced-lens experiment — the first confirmed finding, and what it cost to get there

Eight rounds against clean 4water and three against a repo with a **planted** authorization defect all came back
empty. The planted defect is worth stating precisely: `GET /admin/person/:id/export.json` had its `gate({ req, res },
"admin")` reduced to `gate({ req, res })`, so any signed-in volunteer could export another person's record.
`node --test test/authz-audit.test.mjs` fails on it. Eleven rounds, roughly $0.90 each, none of them found it.

**The experimental design was wrong, and the error was mine.** The question was "given the sibling-path lens and a
repo containing a sibling-path defect, does the agent find it and prove it?" I kept asking it by starting a full round
and hoping an eight-way lens rotation would happen to select `sibling-path`. That is one agent turn's worth of
question routed through a mechanism with no reason to cooperate. Asked directly — one call, the lens stated, the
route/guard table supplied — it costs about **three cents**.

Asked directly, it worked:

```
{"claim":"The /admin/person/:id/export.json route only requires a signed-in user while all other /admin routes
  require the admin role.","where":"src/server.mjs:916","check":"node --test test/authz-audit.test.mjs", …}
verdict: *** CONFIRMED ***   observations: {"before":false,"after":true,"again":false}
```

Right route, right line, and the model's own control proved it: the check failed on the code as it stood, passed with
the fix applied, and failed again when the fix was reverted. 21 seconds, 2,772 tokens.

### Four attempts, four different defects — and every one of them in the probe

The model named the defect correctly on the **first** try and on every try after. Four attempts were consumed by
faults in the harness around it, which is the recurring shape of this whole exercise:

1. **`maxTokens: 700` returned empty text.** Usage said `completion_tokens: 700`, of which `reasoning_tokens: 699`.
   The model spent its entire budget thinking and never reached its output. At 4,000 it was 3,999. Without printing
   usage this reads as a dead model.
2. **A 120-second ceiling, not a token ceiling.** Raising the budget to 16,000 produced
   `external_llm_connection_failed` at exactly 120s — Latch's `timeoutMs`, primary and fallback both 120000. My first
   guess was another reasoning exhaustion; printing the envelope showed it was not. The 4,000-token run took 109
   seconds and only just landed.
3. **A non-unique anchor patched the wrong place.** `find: "gate({ req, res })"` occurs eight times. The gate reported
   "the fix does not make the check pass" — because it had edited an unrelated route and left the defect sitting
   there. The claim was correct; the fix was applied somewhere it was never aimed.
4. **I demanded byte-exact anchors while withholding the bytes.** Given only a summary table, the model invented
   plausible surrounding code — single quotes where the file has double, `const account = await gate(…)` where the
   file says `const c = gate(…)`. It had nothing else to go on.
5. **Then my own table destroyed the bytes it promised.** I rendered each source line with `.trim()`, so the model
   faithfully reproduced the stripped indentation and the anchor missed by four spaces. Everything else in that
   finding was byte-perfect.

Fault 5 is the one worth dwelling on, because **Bureau did the same thing to its own agents**: `searchRepoFiles`
returned `lines[i].trim().slice(0, 200)`. Search is how an agent locates the line it wants to anchor a fix to, and the
gate requires that anchor to match exactly — so the one tool that shows candidate lines was corrupting the only thing
they were needed for. I found that by inflicting it on myself first and then going to look.

### What changed as a result

- **`searchRepoFiles` no longer trims.** Leading whitespace is part of the anchor. Cap raised 200 → 300.
- **An ambiguous anchor cannot patch anything.** `apply()` counts occurrences and requires exactly one.
  `String.replace` with a string pattern hits only the first match, so the previous behaviour could edit a site the
  finding never named — in a remediation flow that is an unrequested change to unrelated code, which is worse than a
  refusal.
- **Refusals say which way the anchor failed** — missing file, not found, or "appears N times … include surrounding
  lines" — because an agent told only "did not apply" retries with the same shape.
- **An empty turn is retried once at 2,600 tokens and emits a `retry` event.** Agent turns asked for 1,000 and never
  escalated, while criteria derivation already climbs a ladder. A reasoning model that thinks past the cap produced a
  silent empty turn indistinguishable from a flaky model.

Tests: the ambiguity refusal is checked on a real repo where the first match is deliberately the *wrong* site, with
the control that a **unique** anchor on the same defect still confirms — otherwise the refusal would only prove the
fixture was broken. The indentation assertion has its own control that the line is found at all, or it would pass
vacuously on zero hits. One assertion I wrote first was vacuous and was replaced: it read the source repo to check
"nothing was patched", but `apply()` works in a throwaway worktree, so the source tree is untouched either way. What
discriminates is that the gate never reached its second observation. 786 unit assertions, 22 in the gate suite, 12
suites green.

### Limits of this result

One defect, one lens, one file, and the lens was **forced rather than selected**. It shows the gate and the lens work
when pointed; it does not show the rotation will point them. The route/guard table was also assembled by the harness —
an agent must build that itself from `read_repo`, and the round that tried searched
`requireAuth|requireAdmin|checkRole` against a codebase whose guard is `gate()`. Nothing here has yet produced a
confirmed finding on code nobody pointed at.

Spend for the whole forced-lens experiment, all eight calls including the two that timed out: **~$0.035**.
Cumulative paid spend across the session: **~$5.34**.

## The autonomous round — a confirmed finding on code nobody pointed at

The paragraph above ends by saying nothing here had yet produced a confirmed finding on code nobody pointed at.
One round, on the code with the anchor fixes in it, did.

```
[ 128s]   Reading the /admin/person/:id/export.json route and its siblings to verify if the admin role guard is missing.
[ 153s]   read   test/authz-audit.test.mjs -> 10680
[ 338s]   -> register_finding "GET /admin/person/:id/export.json lacks admin " cmd="node --test test/authz-audit.test.mjs"
[ 345s]   *** CONFIRMED: GET /admin/person/:id/export.json lacks admin role guard
           src/server.mjs:915  proved by: node --test test/authz-audit.test.mjs
[ 348s]   round 1: 1 confirmed
[ 761s] SPEND: paidTokens=351031 ranPaid=true  $0.702062
```

### Why this counts, step by step

Every one of these was checked afterwards rather than assumed, because the eleven rounds before it failed for eleven
different reasons and most of those reasons were in the harness.

- **The lens chose itself.** The register was left as the previous rounds had left it: `spec-descriptive` at
  `rounds=1`, the other seven at zero. Coverage-first ordering therefore picked `sibling-path`. Nothing was forced,
  and this is the one condition that had never held before — six earlier rounds were spent on lenses with no reason
  to find a sibling-path defect.
- **The agent built its own route table.** Fifteen searches against `src/server.mjs`, assembling method, path and
  guard for itself. In the three-cent experiment that table was handed over by the harness; here it was not.
- **It found the route BEFORE it opened the test.** 128s versus 153s. And `test/authz-audit.test.mjs` does not name
  the route in any case: its `expectedRule()` derives the expectation from the path prefix, `/admin/` implies the
  admin role. So the test could confirm a suspicion but could not supply one. The order matters, because a finding
  read off a failing test is a different and much weaker result than a finding reached by a lens and then proved
  with whatever check the repository already offers.
- **The gate proved it.** fail → pass → fail-again in a throwaway worktree. Afterwards the clone was byte-clean, the
  planted weakening still at line 916, and the audit still failing 1 of 3 — the revert really reverted.
- **The register learned.** `sibling-path` now reads `found: 1, dry: 0, rounds: 1`.
- **The critic fired.** It proposed `route-role-alignment` — *trace the middleware chain for each route declaration
  and verify the applied guard matches the privilege the URL claims* — citing the confirmed finding. Ninth lens in
  the register, available to later rounds.

### Two readouts that lied, both mine

Neither was a Bureau defect, and both would have been reported as one.

- The round launcher printed spend by calling `GET /api/agents`. That route does not exist — `/api/agents` is
  POST/PATCH/DELETE only — so it 404'd, found no agent, and printed **nothing at all**. A spend line that silently
  prints nothing reads as zero spent.
- The register readout asked for `l.yield`, a field that does not exist on a lens. It fell back to `0`, so the lens
  that had just confirmed a finding displayed as barren. The real field is `found`. This was one step away from
  being written up as "the register does not record confirmations".

Both now print `?` for anything genuinely absent, or say plainly that they could not read it. **A readout that
invents a zero is worse than one that errors, because a zero looks like an answer.** That is the same failure as the
search that returned 0 hits for a regex it was matching literally, and the `.length > 0` on a boolean — three
instances in one session of a probe reporting absence it never established.

### What it still does not show

The planted defect was one the repository's **own audit already catches** — it was planted by weakening a guard
until `test/authz-audit.test.mjs` failed. So a provable check was sitting in the repo waiting to be found. The agent
still had to find the route, decide it was wrong, and pick that check; but it did not have to *construct* a check.

The harder case is a defect no existing check catches, where the claim and its control both have to be built. That
is untested, and it is now a cheap experiment rather than an expensive one.

One round, one lens, one defect, one repository. It is a single observation, not a rate.

Round cost **$0.702** (351,031 paid tokens). Cumulative paid spend across the session: **~$6.04**.
