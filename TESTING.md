# Bureau — Testing

## Run it

```sh
node test/run-all.mjs --serve     # pure + server suites; boots a throwaway server on a free port. THE command.
node test/run-all.mjs             # pure suites; server suites only if a server is already up on :4174
node test/run-all.mjs --e2e       # also the live autonomy e2e (needs Latch + a local model)
node test/coverage-audit.mjs      # soft audit: exported fns / routes not tested AND not listed below
node eval/recall-eval.mjs         # recall@3 of memory retrieval, shipped ranker vs alternatives (live)
node eval/parallel-eval.mjs       # sequential-vs-parallel delegation A/B, repeated runs (live, ~4min/pair)
node tools/backup.mjs             # verified snapshot of Bureau + Latch state; --list, --keep N, --root
node tools/restore-drill.mjs      # restore the newest snapshot and boot a REAL Latch on it (live)
.\Install-Heartbeat.ps1 -Verify   # the dead-man's switch, against the REAL Bureau/Ollama/watcher
```

**Where the suite stands right now: <!--fig:assertions-->2,178 headless assertions across
<!--fig:suites-->29 suites** (<!--fig:pure-suites-->23 pure, <!--fig:server-suites-->6 server), plus the
live `--e2e` at 18/18 and the scripted verifications written up below.

_That figure is an instrument, not a note-to-self._ Every number the docs mark with `<!--fig:…-->` is
compared against what the run actually produced, and `run-all.mjs` exits non-zero if any of them
disagrees; the suite counts are settled earlier still, by `docs.test.mjs`, off the runner's own arrays.
It exists because ROADMAP.md claimed "636 assertions across 7 suites" and `test/README.md` claimed "292
in all" across a list of nine suites, for a fortnight, while a real run produced more than twice that
across twenty — and both were true on the day they were typed. **Prose fails exactly like code, and
unlike code it is never re-executed.** The narrative below deliberately keeps its dated figures (786 →
792 → 819 → 832 → 852) as a record of what each commit measured; those are history and are not checked.
Only the live claims carry markers. _The idea is borrowed from 4water's `test/docs.test.mjs`, which
checks its documents against its code and explicitly declines the assertion count because a suite cannot
spawn its own runner — hence the split here: counts are settled by the runner, not by a suite._

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

`--serve` self-hosts a Bureau on **a port the OS says is free** (generating its own `OPERATOR_TOKEN`, so
no Latch/auth.json needed) and tears it down after. Exits non-zero on any failure — it's the pre-push and
CI gate. `BUREAU_PORT` still pins the port when you want a known one.

**It used to self-host on a fixed :4174, and that is a defect this repo produced rather than imported.**
Several agent sessions work in sibling git worktrees off one clone and every pre-push hook runs
`run-all --serve`, so two gate runs overlap routinely. `bootServer()` returned early on "something is
already listening" — and generated its disposable `OPERATOR_TOKEN` on the line *after* that return, so the
second run reused the first run's server without ever learning its token. Measured 2026-08-15: `api`,
`workspaces`, `endpoints`, `robustness` and `mcp-floor` all red with `status 401` and "could not create
test workspace", plus `HARNESS ERROR TypeError: Cannot read properties of undefined (reading 'length')` at
`workspaces.test.mjs:29`. Every symptom pointed at the source. The cause was the port.

Three things changed, and `test/gate-harness.test.mjs` (pure) holds all of them:

- **`--serve` no longer shares a port**, so concurrent runs cannot meet. Deliberately NOT applied to the
  bare command: `node test/run-all.mjs` documents "server suites run if a server is already up on :4174",
  and an ephemeral port there would find nothing every time and skip them in silence — the exact
  regression-hiding failure `--serve` was added to end.
- **A server we did not start is probed on an *authenticated* route before it is reused.** `serverUp()`
  probes `/`, which is not token-gated, so it can answer "is something listening" and never "is it mine".
  A 200 is not sufficient either, and that is measured rather than argued: Latch's narrower `agentToken`
  authenticates and `/api/whoami` answers **200 with `role: "readonly"`**, on which every mutation 403s.
  The permit is an allowlist of one — `role === "operator"` — and everything else is refused by name.
- **`workspaces.test.mjs` diagnoses instead of throwing.** It reads a company before it asserts anything,
  so a refused credential surfaced as a `TypeError` on `.agents.length` — a stack trace naming the line
  that tripped and nothing about the cause. It now reports the status, which credential it resolved and
  where from, and what to do about it. A second guard stops the run if workspace creation returns no id:
  an undefined id sends no `x-workspace` header at all, so the whole suite would silently re-target the
  **default** company and report a dozen unrelated-looking failures against real data.

_Controls, all mutate/restore with the restore hash-verified: 29 assertions, and each one was shown to go
red under a mutation naming it — reuse-anything (the original defect) turns 10 red; reuse-nothing turns the
permit half red; probing on status alone turns exactly the two read-only assertions red; probing `/` instead
of `/api/whoami` turns all four live-probe assertions red; removing the preflight puts the `TypeError`
back. Two assertions were **rewritten because their controls left them green**: `typeof … === "string"`
passed even with the probe pointed at `/` (role comes out null and a different branch returns a string
anyway), and the bail exit code alone could not tell a diagnosis from a `TypeError`, since both exit 2._

**The exit-code rule is about WHEN, not about which call is safer — and both directions cost something
here.** Calling `process.exit()` immediately after a `fetch` on Windows trips the assertion
`!(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94` that `tools/heartbeat.mjs` documents: the
refusal path printed a perfect diagnosis and then died with **exit 127**, and `workspaces.test.mjs`'s bail
returned **3221226505** instead of 2. The pre-push hook blocks on any non-zero code so the gate held
either way, but 127 means "command not found", which is the wrong story to tell someone whose push was
just refused. So bail paths set the code and return.

Then the same fix applied to the *end* of a suite went wrong the other way, and a control caught it. With
`gate-harness.test.mjs` ending on `process.exitCode`, the C8 mutation — `freePort` returning without
`s.close()` — left a listening socket, the event loop never drained, the suite never exited, and
`run-all`'s `run()` waits on child close with no timeout. **The control that should have gone red hung the
whole gate instead**, and a 10-minute cap was the only thing that ended it; worse, the controls script
died between mutate and restore and left the defect in the working tree. So: `process.exit()` at the
natural end of a suite, where termination must be guaranteed and the last fetch is subprocess-lifetimes
ago; `process.exitCode` + return only on the paths that fire within a tick or two of one. _The controls
script now runs each suite under a timeout and restores on exit, because cleanup that has never been
watched is not cleanup — the same lesson the workspace sweep in `workspaces.test.mjs` carries._

_What is verified by hand rather than by an assertion: that `main()` actually calls the refusal before the
first suite. A suite spawning `run-all` is a recursion hazard — `run-all` runs that suite — so this one is
measured and recorded instead. With a foreign server on :4174 holding a different token, the bare command
refuses in **0.12s** with exit 2, where it previously spent ~2 minutes on the pure suites first and then
reported five red server suites. The decision function behind it, `reuseDiagnosis`, is unit-tested against
every status a real server answers with._

## The gate (how we avoid pushing broken/untested code)

1. **Pre-push hook** (`.githooks/pre-push`) runs `coverage-audit.mjs` and then `run-all.mjs --serve`, and
   blocks the push on either. Enable once per clone: `git config core.hooksPath .githooks`. Emergency
   bypass: `git push --no-verify`.
2. **CI** (`.github/workflows/test.yml`) runs both on every push/PR — the authoritative gate.
3. **This ledger + `coverage-audit.mjs`**: every exported function and `/api`+`/mcp` route must be
   either referenced by a test OR listed under "Intentionally not auto-tested" below (with a reason).
   The rule: **no new export/endpoint ships without a test or a ledger entry.**

   _This item spent a while claiming to be a gate without being one._ CI ran it as
   `node test/coverage-audit.mjs || true`, the pre-push hook did not run it at all, and the script's own
   header called it "a soft nudge, not a hard gate" — three artifacts, two stories, and the rule above
   enforced by nothing but memory. It is wired for real now, and it fails the build.

   **`accounted()` matches on word boundaries, not substrings.** While it was a substring match an export
   named `sum` or `emit` was satisfied by `checksum` or `emitted` — the gate could not fail falsely, but it
   could be silently satisfied, which is the worse failure for something that blocks a push. _This paragraph
   is itself inside the scanned corpus, so an illustrative name here must not be a real export: a third
   example was dropped from that list on finding it was one, which would have let the ledger account for a
   real symbol purely by discussing the matcher._ Boundaries apply only on an edge that is itself a word character, so `/relocate` and
   `/steer` — registered via `.endsWith()` and only ever reached as `/api/run/<id>/steer` — keep matching;
   requiring a delimiter before the leading `/` was tried and reported both as false gaps. Hardening the
   matcher surfaced **no new gaps**: all 127 exports and 73 routes were already accounted for by name.

   The matcher carries its own negative control and runs it on every invocation, because a checker that
   quietly stopped discriminating would print the same clean bill of health as one that works. The control
   derives both halves from the live corpus — a real word must be accounted, its two-character truncation
   must not — so it fails if the matcher is reverted to substring, pinned to `true`, or pinned to `false`.
   Evidence, mutate/restore with the restore hash-verified: reverting to `includes()` → self-test names the
   boundary regression; `() => true` and `() => false` → self-test fires on the negative and positive half
   respectively; adding a new export named by truncating `heartbeat` by two characters — a string the corpus
   contains only inside that longer word — → **reported as a gap** under the new matcher and **silently
   accounted** under the old one. That last pair is what makes the control matcher-specific rather than
   merely noticing that a new export appeared. The truncated name is deliberately not written out here:
   spelling it would place it in the corpus as a word and retire the control that depends on its absence.

   Still true, and the reason transitive-coverage entries below carry mutation evidence rather than a
   pointer: it asks "did anyone account for this name", not "is this exercised". A mention in a comment or
   an unrelated local of the same name in a test still counts. (`configuredPaidModel` is the live example —
   its only occurrence in a test file is a comment; it is legitimately carried by its ledger entry below,
   not by that comment.) Two entries in the route list, `/api/` and `/mcp`, are router prefixes rather than
   endpoints and are accounted no matter what.

## Suites

- **Pure** (`decision`, `units`, `net`, `action-surface`) — no server, no model. Logic, validators, SSRF guard,
  BM25, the semaphore, the approval-decision core (incl. hard floor), and the model-facing action surface —
  every actionType the model can reach has a dispatch branch or a registered reason it has none.
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
| Own-work recall `ownWorkQuery` / `rankOwnWork` / `ownWorkBlock` — lens-vs-objective query, both empty cases | units |
| …and that `runAgentTask` actually INJECTS the ranked block (read off the provider stub) | hunt-dispatch |
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
| Unrated paid model: `unratedModelWarning` names model + consequence, `unratedTierModels`, warn-once | units |
| …and both wirings fire in a booted server — at BOOT (`kimi-k3`) and at RUN START (Latch's model) | hunt-dispatch |
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
- `askLlm`, `paidProviderAvailable`, `initLatchAuth`, `configuredPaidModel` — thin wrappers over the
  model/Latch. `configuredPaidModel` now also warns when Latch's model has no `MODEL_RATES` entry, and
  THAT half is covered end-to-end in `hunt-dispatch` (the stub advertises an unrated `fallback`).
- The **third** rate-table funnel — `warnUnratedModel(meta.model)` on a real paid call — is units-only.
  It needs `meta.paid`, which needs a funded agent and genuine external routing; the stub in
  `hunt-dispatch` deliberately leaves every agent at `budgetUsd: 0` so nothing routes paid. The two
  funnels that fire without money (boot, run start) are both asserted against a booted server.
- `ragTokens` — trivial tokenizer, exercised transitively by the `rankByRelevance` tests.

**Covered by BEHAVIOUR, not by name.** The audit matches symbol names against test sources, so a function
that is only ever reached through a caller reads as a gap. These are not gaps, and each line was checked
the only way such a line can be checked — mutate the function, watch the named suite go red, restore:
- `jsonSpan` — `safeParse` and `jsonFailure` both walk it, and `jsonFailure`'s four diagnoses (`truncated`,
  `raw-newline`, `prose`, `syntax`) are read straight off its return. _Control: forcing it to report "no
  JSON here" turned **12** `units` assertions red, across both callers._
- `probeAssertsSourceText` — `normalizeFinding` calls it; `finding-gate.test.mjs:260` drives a probe that
  reads the file it is about and asserts on its text. _Control: forcing `false` turned that assertion red,
  and the gate CONFIRMED the source-text probe — which is the defect the function exists to stop._
- `unknownPolicyAction` — both `/api/policies` write paths call it; `api.test.mjs:154-159` asserts 400 on
  an unknown actionType, that nothing was stored, and that PATCH leaves the old condition intact.
  _Control: forcing `""` turned **3** `api` assertions red._

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
  prompt was offering an action that does nothing. Removed; `note` is the implemented catch-all. _That last
  clause was false the day it was written — `note` had no branch either, and did not get one until `97fda1a`
  nine days later; see below. `other` is now refused by name with a reason before dispatch, three in a row end
  the round, and it is registered in `UNEXECUTED_ACTIONS` as the one action deliberately left unexecuted._
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

Also found while measuring: **`note` was enumerated, and documented from this same day, but it was never
implemented.** _This paragraph originally said the exact inverse — "implemented and enumerated but was never
described to the agent" — and it was wrong in the direction that mattered. It stood for nine days, 2026-08-06 to
2026-08-15._

There was no dispatch branch, and `note` could not have reached one anyway, because two layers above the
dispatcher rewrote it first:

- **`normalizeAction`'s catch-all.** It had treated `note` as a vague choice to reinterpret since the initial
  commit — back when the word really was model noise — and "note" is itself in the `wantsWrite` regex, so a note
  headed *"Note on X"* with a paragraph under it became a `file_write`. Measured over five notes written exactly
  the way the doc line asks for them, **four came out as a different action**: two `file_write`, one
  `web_research` (it had quoted the URL it checked), one `web_search`.
- **The turn loop's finish coercion**, which swallowed the fifth. It listed `note` beside "done", "stop" and
  "nothing", so the one short neutral note that survived rewriting ended the agent's task instead of recording
  anything.

So the single action offered for an honest empty-handed round was also the one that **stopped** the round — or
silently escalated it into a disk write or a live fetch. The two halves landed **four commits apart on the same
day**: `9d11bae` put `note` in the finish list while it was still noise, then `8f77c4d` documented it as the RIGHT
answer for "I looked and found nothing" and revisited neither layer. `units.test.mjs` asserted *"while `note` —
which IS implemented — still is"* and was green the whole time, because it checked the **enum's spelling** and
then said something about a **dispatcher nothing had looked at**.

**Fixed in `97fda1a` (2026-08-15).** `note` has a branch, beside `plan_add` and **above the approval seam** — the
doc line promises it runs instantly and changes nothing, and routed through `fileApproval` on the default
`supervised` tier it would instead park the agent for up to ten minutes waiting for a human to approve a no-op. It
sets `didExecute`, because this IS the work product of a round that found nothing and the finish guard would
otherwise answer an honest note with *"NOTHING has actually run yet"* — the nag that makes an agent invent an
action. It records on `run.notes`, emits, and reaches the company audit through `emitResult`, so no new collection
and no new panel. `normalizeNote` refuses a note carrying only a heading, for `declined_check`'s reason: a shrug
and a round that never looked leave the same mark on the record. Policy and the action cap still apply, so no
approval does not mean ungoverned. `note` is out of the catch-all and out of the finish list, and the rule those
two now encode is written down: **that layer may sharpen a VAGUE choice, never overrule a documented one.**

### The checker for the whole class: `action-surface.test.mjs`

Advertised-to-the-model, undispatched has now shipped three times — `other`, `note`, `email_draft` — and reading
never once caught it, because the model-facing surface is **four lists in one file that nothing compared**: the
response schema enum, the prompt's action catalogue, `normalizeAction`'s synonym table, and the dispatcher. Every
one of the three was introduced by someone editing one list correctly.

So the deliverable is a checker rather than a fourth correct list. `test/action-surface.test.mjs` (pure) derives
both sides from `server.mjs` — through `test/action-surface.mjs`, which holds the parses so `docs.test.mjs` can
read these counts without importing a suite that asserts at import time — so it cannot be satisfied by editing
itself, and it canonicalises the reachable side by **calling** the real `normalizeAction` instead of reasoning
about what it would do — precisely the gap the `note` defect lived in.
**<!--fig:reachable-actions-->133 reachable names against <!--fig:dispatch-branches-->23 branches** (both pinned
by `docs.test.mjs`, so this sentence goes red rather than stale); anything left over must be named in the new
`UNEXECUTED_ACTIONS` export, which holds `other` alone. It also asserts each parse is non-empty *before*
concluding anything from it (the empty set is a subset of everything, so a silently broken parser would report
green forever), that every action the catalogue promises "runs instantly" is dispatched above the approval seam,
that a documented action survives all four rewrite heuristics — with controls that those heuristics still fire for
a vague choice — and that nothing the prompt documents is coerced into a finish. The dispatcher parse is **scoped
to `runAgentTask`**, which is load-bearing: unscoped, `actType === "email_draft"` matches inside
`requiresCeoAlways`, and the checker would have pronounced `email_draft` dispatched on the strength of the line
proving it needs a human. A control asserts the scope holds.

**Stated limit, measured rather than assumed.** The dispatched side is source text, so it answers "is there a
branch of this name", not "does that branch run". Disabling the `note` branch with `&& false` left the suite
green; **renaming** it — the shape the real defect had — went red at once. Closing that gap needs a turn loop
driven end to end, which needs a provider and a Latch the pure suite cannot have. Both defects it was written for
were absent branches, not dead ones.

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
the panel belonged in a commit that also ran `node test/run-all.mjs --ui` and looked at it.

**That commit has now landed.** The register renders as the **Not checked** panel, between Open questions and
Deliverables — each card showing what was not checked, the reason given, what would unblock it, and the refuter's
counter-argument where there is one. It was looked at in a browser, which is how the one defect no assertion would
have caught was found: the "Drop it" button wrapped mid-phrase, fixed with `white-space:nowrap`.

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

## The limit that made all of this narrower than it looked — and the probe that lifts it

The section above ends by naming the untested case: a defect **no existing check catches**, where the agent must
construct the control as well as the claim. Attempting it produced an architectural answer rather than an empirical
one, and it needed no model call.

The gate's sequence begins *the check FAILS before the fix*. If nothing already fails because of the defect, that is
false on step one. And the agent could not supply the missing check either: a fix is one find/replace against an
**existing** file, so `apply()` could not create a test. Measured on real 4water, with a real defect:

```
a real defect in real 4water, whose check passes:
  -> REFUSED — the check passes already, so it does not see the defect described
     obs {"before":true}
```

**So the hunt phase could confirm only defects that some existing check already failed on. Against a green
repository it could confirm nothing, by construction.** Three consequences, all of which were being misread:

- The **eight dry rounds against clean 4water** were guaranteed dry before any lens was chosen. They were written up
  as lens-register and tooling problems. Those problems were real; they were also not why those rounds were empty.
- The one confirmed finding came from a repository deliberately made **red**.
- It compounds. Dry rounds count *confirmed* findings only and two dry rounds retire a lens — so a lens that kept
  surfacing true-but-unprovable defects would be retired as barren. The register was set up to discard exactly the
  lenses that were working.

And it cuts at the subsystem's own origin. The motivating observation was that 4water was feature-complete at commit
35 while the 121 commits after it found real defects, none of them in any acceptance criterion. **None of those had
a failing test at the time either.** The mechanism built to catch that class of defect could not catch any of it.

### What changed

The principle is unchanged — the RUNNER performs the control, never the agent. What changes is that the control no
longer has to pre-exist. A finding may carry a **probe**: a new test the agent writes, which the runner writes into
the worktree, runs, and throws away. `check` is *derived* from the probe rather than accepted alongside it, so a
probe cannot be paired with a command that runs something else. The runner then observes:

1. the probe **fails** on the code as it stands
2. it **passes** once the fix is applied
3. the project's **existing suite still passes** with the fix — new, and it stops a "fix" that breaks the app
4. it **fails again** with the fix reverted and the probe kept

Step 4 is what makes an agent-authored control admissible: a probe insensitive to the source cannot survive it.

Four refusals guard the rest, each with its own test: a probe that **reads the source file and asserts on its text**
(the proxy problem in its purest form — fails, passes, fails again, while testing nothing about behaviour); a probe
that passes regardless; a fix that satisfies the probe but breaks the existing suite; and a probe that would
**overwrite** an existing test rather than add one, which would let an agent replace a check that disagreed with it.

### End to end on the real repository

4water at HEAD, one planted defect: `workloadSpread()` reports `min: 0` whatever the counts are, so a planner reading
the distribution concludes somebody has no shifts while everyone has three. `spread` and `max` stay correct, which is
why nothing notices — every assertion on this function is about `spread`. **All 534 of 4water's own tests pass with
it in place.**

```
with an EXISTING check (npm test):      REFUSED — the check passes already      obs {"before":true}
with a PROBE the agent writes:          *** CONFIRMED ***
    obs {"suiteBefore":true,"before":false,"after":true,"suiteAfter":true,"again":false}
the same probe, defect reverted:        REFUSED — the check passes already      obs {"before":true}
```

The third line is the control and it is the point: the same probe against code without the defect **refuses**. It is
sensitive to the defect rather than a test that always fails. Without that line, "confirmed" would mean only that the
probe failed somewhere.

The middle line also failed on the first attempt — `the anchor text appears 2 times` — because `min: 0,` occurs
twice in that file. That was a sloppy anchor of mine, caught by the ambiguity guard added earlier in this same
session. Worth recording as the guard doing its job on its author.

### Reachability, which is a separate thing from working

A field the dispatcher reads that nothing tells the model about is not a capability — 4water's lesson, applied here.
So: the action description explains the probe form, the round's own instructions state plainly that **most real
defects are not caught by any existing test — if one were, somebody would already know**, and there are now two
worked `register_finding` examples in the prompt, one per form. A test parses both **out of the built prompt** and
pushes them through the real `normalizeFinding`: an example the gate itself would refuse teaches the model to emit
findings that get refused.

That test failed first against examples that were perfectly valid, because it unescaped the source text by hand and
undid two layers in the wrong order — turning `\n` into a real newline inside a JSON string. Reading the *built*
prompt is simpler and is also what the model actually sees. The probe was broken, not the thing probed; third time
in this session.

Suites after this work: **792 unit assertions, 36 in the gate suite, 12 suites green.** No model calls were spent on
any of it.

## Three live rounds on a GREEN repository, two refuted hypotheses, and one real defect in the outline

The probe path works in the gate. Whether a model *reaches for* it when nothing already fails is a different
question, and it needs a live round. Target: a clone of 4water at HEAD with one planted defect its own suite passes
straight over — `workloadSpread()` returns `min: 0` whatever the counts are, so the reported distribution says
somebody has no shifts while everyone has three. **534/534 of its own tests pass with it in place.**

Three rounds, same lens (`what-would-it-accept`, selected by the register's own coverage-first ordering, not set by
me), same repository. All three dry, and **`src/roster.mjs` — where the defect lives — was never opened once.**

### Hypothesis 1: company memory was anchoring the rounds. REFUTED.

The first round opened by reading `test/authz-audit.test.mjs` — the exact file from the previous round's confirmed
finding, in a clone that does not contain that defect — then spent itself on guards. Memory looked obvious.

It was not even the right mechanism. `recallSharedMemory` skips the agent's own entries (`if (a.id ===
excludeAgentId) continue`) and Ada is the only agent, so shared recall was **empty**. The actual injection is
`ownWork` at `runAgentTask`: the agent's own last five memories, ordered by RECENCY with no relevance filter at all,
framed *"build on it, don't repeat it"* — which the lens cannot influence even in principle.

So the control: clear Ada's memory, reset the lens so the same one is picked, change nothing else. **The round went
to authorization again.** Memory was not the cause, and without that run this would have been written up as a
finding. (`rounds` is not stored either — it is derived as `found + dry`. Resetting the field I first reached for
would have done nothing.)

**The mechanism it named is now closed, even though it was not the cause.** `ownWork` is ranked rather than sliced:
`ownWorkBlock` → `rankOwnWork` → the same `rankByRelevance` the cross-team block was already using one line below.
What it ranks AGAINST is the part worth stating, because "the objective" is the wrong answer on a hunting round —
`investigateObjective` is 7,225 characters of standing instructions and repository digest yielding 173 BM25 query
terms, of which the lens contributes 15 (**8.7%**), and the other 91% is identical every round AND is the vocabulary
every hunt memory is written in. So the query is the LENS on a hunting round and the objective everywhere else.
"Objective **and** lens" is not a third option: `ragTerms` de-duplicates the query and the objective already contains
`lens.prompt` verbatim, so appending it yields a byte-identical term list — asserted in units, not just claimed here.
The lens can now influence own-work recall, which is exactly the thing this paragraph said it could not do even in
principle.

#### The same query was diluted two lines further down, and "shared recall was empty" is why nobody looked

The paragraph above closes with `recallSharedMemory` skipping the asking agent, Ada being the only agent, and the
cross-team block therefore being **empty**. All true — and it reads like a reason that block was fine. It is not.
It is a fact about the company that hunt ran in, not about the code: `runHunt` picks one agent out of `org.agents`
and nothing bounds that roster to one. Give the company a second agent and the block is populated, ranked against
the same 7,225-character blob the own-work fix was about. `retrieveRelevant` eleven lines below does not even have
that reprieve — deliverables belong to the company and are excluded only by name, so the deliverable block is
populated **on exactly the single-agent hunts where the cross-team one is empty**.

Both were already "ranked", which is why they looked finished. Ranked, and ranked against the right thing, are
different properties; only one of them had been established. Measured over 24 teammate memories into four slots,
across the eight built-in lenses:

| ranked against | lens-invariant slots | mean pairwise Jaccard across lenses | the lens's own top pick |
| --- | --- | --- | --- |
| the whole objective | **3 of 4** | 0.69 | absent 2/8, displaced 5/8 |
| the lens | 0 of 4 | 0.11 | at rank 1 by construction |

For 28 of 28 lens pairs the objective-ranked block is at least as lens-insensitive as the lens-ranked one, and for
one pair — `stale-claim` against `collector-blind`, two lenses with nothing whatever in common — the four entries
are **identical**. The deliverable block behaves the same way at 2 of its 3 slots.

The semantic half is worse, not better, which is the opposite of the intuition that a vector "understands" more.
`recallSharedMemoryHybrid` calls `embedText(query)` on the same blob, so the digest is most of what gets embedded.
Against the local `nomic-embed-text`: query vectors for the eight lenses sit at mean pairwise cosine **0.9746**, and
deleting the lens from the objective **entirely** moves the vector by 1–2% (cos 0.977–0.991 against its own
lens-free text). A vector that cannot tell whether the lens is present cannot rank by it.

So `ownWorkQuery` is now `recallQuery` and governs all three blocks. Five negative controls, each
mutate-confirm-red-restore with the restore verified by hash. Two are worth recording. **The deliverable control
failed first**: reverting that call site to the objective changed nothing and the check stayed green through the
exact defect it was written for, because all three seeded documents were topical and none competed on the standing
instructions' own vocabulary. It discriminates now because a `probe-register` decoy was added, dense in
probe/finding/round/register/repository — which is what the diluted query is mostly made of. **The unwiring controls
threw rather than failed**: with the block never pushed, the extractors read off `undefined` and took every later
assertion in the file down with them. A missing block has to make each assertion red on its own terms, so the
extractors tolerate absence and the floors carry the verdict — 6 clean reds for the cross-team block, 3 for the
deliverable one.

One measurement was wrong before it was right, and it is the same mistake in two places. The first pass reported the
cross-team block as **completely constant** across all eight lenses. It was constant — from a corpus of five
memories into four slots, where returning everything is arithmetic rather than evidence. The corpus went to 24 and
the honest figure is 3 of 4. The end-to-end fixture then hit the identical trap from the other side: two seeded
memories against a four-slot block, where RRF fusion returns both whatever the query, so "the irrelevant one is
absent" was never something the ranker could have falsified. Both now assert ORDER over a corpus larger than the
block, which is also what survives the hybrid half being live on one machine and absent on another.

#### The same dilution on a NON-hunting run. REFUTED, and the reason is worth more than the result.

`recallQuery` returns the objective off a hunting round, so the obvious next question is whether the objective is
itself diluted there. It is, by three appends — acceptance criteria (`server.mjs:3903`), the undecided-decisions
block (`3907`) and the QA remediation preamble (`3837`). The fixed template text is **46-48%** of
the query on a run with undecided decisions and **30-33%** on a remediation pass, against the hunt's 91%. That
looked like the same defect at a smaller scale. It is not the same defect at all.

Measured over 20 documents into three slots, three unrelated construction tasks, all five query forms:

| | hunting round | construction run |
| --- | --- | --- |
| top slot holds the right item | 1 of 8 | **14 of 15** |
| mean block overlap across unrelated queries | 0.69 | **0.30** (0.00 on the bare objective) |
| query vectors across unrelated queries | cos 0.9746 | cos 0.40-0.68 |

**Nothing was fixed, because nothing established a defect.** Three probes had to be voided first, and they are the
record worth keeping:

- **Query length, refuted by control.** Padding the objective with same-size prose drawn from vocabulary no document
  uses reproduces none of the effect — the block stays exactly where it was without the padding. So whatever moves
  the ranking is the boilerplate's WORDS, not the query's size.
- **Convergence, refuted by corpus size — twice.** Two runs reported unrelated tasks converging on an identical
  block (overlap 1.00). Both used five documents into three slots, where filling the block is arithmetic. At 20
  documents it is 0.30. This is the third time in this session that a corpus smaller than the block manufactured a
  result, after the 5-memory cross-team measurement and the 2-memory end-to-end fixture above.
- **Slot occupancy, refuted by the fixture's own decoy.** A process document did take slot 2 in 3 of 3 blocks as
  soon as criteria were appended — but the decoy nearly quoted the remediation sentence back. Re-run with a plainer
  process document ("how work is signed off here") it is pulled 1 of 3 times; with a mundane one ("our weekly
  rhythm: standup Monday…") never. The effect was mostly the fixture.

The asymmetry is principled rather than lucky, and the share of the query is the LESS important half of it. On a
hunt the boilerplate is also the vocabulary every hunt memory is written in — noise and corpus share a dictionary,
so BM25 adds score for boilerplate matches on every candidate at once. On a construction run the appended text is
process language and the corpus is ordinary company documents that do not share it. Take that second condition away
and 91% would not have mattered either.

One residual, narrow and conditional: the fixed remediation sentence alone ranks a near-verbatim delivery-process
document at **13.97 against 2.30** for the runner-up. A company that keeps a definition-of-done document will see it
surface in the deliverable block on remediation passes, costing one of three slots — it displaced the top slot once
in fifteen. Not worth a change, and the change would be a different shape anyway: the offender is text addressed to
the agent about HOW TO WORK rather than about what the work is, so the fix is stripping the fixed templates, not
reusing `recallQuery`.

### Hypothesis 2: the outline was steering them. ALSO REFUTED — but it was a real defect.

`src/server.mjs` is 79,219 characters against a 12,000-character paid read cap, so a turn sees **15%** of it and
leans on the attached outline for the rest. That outline reported **15 symbols and none of the file's 50 routes** —
`repoOutline` matched declarations only, and the routes are `app.get("…", …)` expressions. Its most prominent
entries were `gate` and `postGate`, near the top. Both rounds duly tried to read those two bodies by search.

Fixed: the outline now also reports route registrations and test declarations, including one behind a condition
(`if (devAuth) app.post("/auth/dev", …)` was the single route of fifty still missed without that). On the real file:
**50 of 50 routes, and the 15 declarations still there** — controls both ways, since an outline of only routes is
the same failure pointing the other direction, and a pattern matching every method call would be noise.

Re-run with the fix, everything else held identical to the control:

| | round 1 (memory) | control (no memory) | fixed outline |
|---|---|---|---|
| time | 773s | 626s | **450s** |
| cost | $0.563 | $0.593 | **$0.467** |
| tokens | 281k | 297k | **233k** |
| ending | hit the round cap | hit the round cap | **stated a conclusion** |

28% faster, 21% cheaper, and it stopped burning turns on exact-string searches that returned nothing — the control
searched `return gate({ req, res }, role);` for 0 hits **twice**. Most importantly it ended by *saying* what it
found: *"This lens showed nothing. All routes in the admin and planner groups have consistent guards, and the
authz-audit test already enforces that every route…"* — an honest empty round instead of one that simply ran out.

**But it did not change WHERE the round looked.** The outline was a genuine defect worth fixing on its own merits;
it was not the steering cause.

### What is left, and it is the register's own credibility

Three rounds under `what-would-it-accept` — *"ask what this check would ACCEPT"* — all went to authorization. That
lens's wording reads as an authorization question to a model looking at a web app. If a lens cannot move attention
off the biggest file in the repository, coverage-first ordering is choosing between labels rather than between ways
of looking, and the register is weaker than it appears.

The test is cheap and direct: `collector-blind` (something computed and shown to nobody) is almost a description of
the planted defect — 4water's own `PLAN.md` says `workloadSpread` "was computed for the tests and shown to no one".
If the lens steers, that round opens `src/roster.mjs`.

Cumulative paid spend across the session: **~$7.63**.

### The fourth round, and where the money actually goes

`collector-blind` — *"for each check, ask what happens if its COLLECTOR returns nothing"* — went somewhere
completely different: `tools/precheck`, `tools/deadassert`, `tools/sourcewalk`, `tools/proseproof`, the
reachable / docs / strings / css-audit tests, `src/retention.mjs`. **Zero authorization, and `src/server.mjs` never
opened.** After three rounds that all went to `gate`/`postGate`, one lens change moved attention wholesale. **The
register works** — coverage-first is choosing between ways of looking, not between labels. It ended on a conclusion
that is correct about 4water: the codebase really has been hardened against empty-collector blind spots, which is
why `tools/sourcewalk.mjs` exists at all.

Still dry, and still nothing in `src/roster.mjs`. Four rounds, four dry, on a repository with a planted defect.

**But it measured the cost driver.** That round: 201 seconds, 442,274 tokens, **$0.885** — the shortest and the most
expensive of the four, against $0.467 for one that ran 450 seconds. Wall-clock is not the driver; **accumulated read
bodies are**, because the history is re-sent whole on every turn.

Fixed by collapsing older read bodies to their outline before sending (`collapseReads`), keeping the two most recent
verbatim. Simulated on exactly the files that round read: **500,636 tokens → 217,718, a 57% saving** on what gets
billed; $1.00 → $0.44. That estimate brackets the 442,274 actually observed, so the model is sound.

Two things the tests forced, both of which would otherwise have been defects:

- The two most recent bodies stay **verbatim**. A finding's anchor has to quote text that really appears in the
  file, and an agent working from a half-remembered body invents anchors instead — measured earlier in this
  session, when a model shown only a summary table got the route, the line and the variable right and the quote
  style wrong. So a collapsed read says outright that it can no longer be quoted from, and lists only what it still
  knows is declared there.
- **A size floor.** The first version made the history BIGGER for small files: the warning plus the outline runs to
  a few hundred characters, so a five-line file went from 542 to 869 when "saved". The assertion written to stop
  this being decorative is exactly what caught it. Below the floor, the body stays.

Cumulative paid spend across the session: **~$8.51**.

### The whole-repo digest — repomix's idea without repomix

Four rounds groped file by file, and three never left the first big file they opened, because nothing told the
agent what existed until it opened something. `repomix --compress` is built for exactly this: Tree-sitter keeps
signatures and drops bodies. Its per-file token counts would have identified `src/server.mjs` at 79KB against a
12KB cap in seconds rather than over two live rounds and a refuted hypothesis.

Not wired in, for two reasons that are not preference. Bureau is **zero-dependency by design** and repomix brings
Tree-sitter grammars plus tokenizers. And the **hard floor blocks it anyway**: `shell` always requires the CEO,
which is why a finding's check is confined to the project's own entry points, so a round cannot invoke it. It could
only enter as a pre-computed pack — and a pack is a *snapshot*, so a round reading a stale one produces false
absence, the exact bug class this session kept hitting.

So: the idea, from what Bureau already has. `repoDigest` walks the repository at round start and `digestText`
renders it under a budget. For 4water that is **87 files in ~2,000 tokens**.

Two design points that are the whole value:

- **The index is always complete; the breakdown is what gives way.** Every source file gets its line, whatever the
  budget does. The first version budgeted symbols first and rendered ten files of eighty-seven — a map that stopped
  at the letter N while calling itself a map, which is how an agent concludes something is absent when it was
  simply never shown. Tested under a budget too small for any breakdown at all.
- **Sizes are the point.** A file marked `(>read)` is larger than one read returns, so reading it yields a prefix.
  Every false-absence claim this project has produced came from reasoning about a prefix as though it were the
  file, and 48 of 4water's 87 files are over that line. Saying so once up front is cheaper than the agent
  discovering it per file, which is what the wasted rounds were.

It also closed a silent zero found while testing it: `listRepoFiles` answers `{ok:true, files:[]}` for a path that
does not exist, so a mistyped `guardrails.findingRepo` rendered as an empty map rather than an error. `repoDigest`
now stats the path first and says which it is.

The digest replaces the vocabulary block rather than joining it — same names plus line numbers, sizes and routes,
and sending both would pay twice every turn. It is not free: ~2,000 tokens on each turn of a round. Against a 57%
saving from collapsed reads, and against three rounds spent discovering a file was too big to read, that is the
trade being made deliberately rather than by accident.

Suites: **819 unit assertions, 12 suites green.** No model calls were spent building any of it.

### The fifth round: measurably better machinery, still nothing found

Same lens, same repository, memory cleared — the conditions of the $0.885 baseline, with the digest and the
collapse in.

| | baseline | digest + collapse |
|---|---|---|
| cost | $0.885 | **$0.600** |
| tokens | 442,274 | **300,110** |
| behaviour | 13 whole files read, then reconstruct by search | 5 files, then targeted searches |

**32% cheaper.** Predicted nearer 40–57%, and the gap is the digest paying itself back: the collapse saves on reads,
the digest costs ~2,000 tokens on every turn. That trade was named before the round and is now measured.

The behaviour is better in ways worth recording. It searched `app.get("|app.post("` and got all **50** routes on the
first attempt — the outline fix — where earlier rounds spent a dozen turns reconstructing the route table. It read
five files instead of thirteen. And it ended on a claim that is true of 4water: *"Every collector I found has a
floor check that prevents a vacuous pass on an empty set."*

**But the digest did not do the thing it was built for.** The round still opened on `src/server.mjs`, and
`src/roster.mjs` — listed in the map, holding the planted defect — was never opened. Across five rounds no round has
touched that file.

### Where this honestly stands

- A confirmed finding on code nobody pointed at: **once**, on a repository deliberately made **red**, where an
  existing check already failed.
- On a **green** repository: **zero, in five rounds**, about $3.00 of hunting.
- Every mechanism is better than it was — probe gate, exact anchors, ambiguity refusal, empty-turn retry, outline,
  collapse, digest — all unit-tested at 819 assertions. None of it has yet produced the outcome it exists for.

The part that is not a tooling gap: the planted defect is *precisely* a `what-would-it-accept` defect. Every
assertion on `workloadSpread` is about `spread`, so `min` can be anything — "what would this check accept?" is the
exact question that exposes it. **Three rounds under that lens went to authorization instead.** Cheaper reads do not
address that.

The experiment worth running next, and it is now about $0.40: a **small** repository where no file exceeds the read
cap. That isolates whether five dry rounds are about scale — a 79KB file against a 12KB window — or about judgement.
Until that runs, both explanations remain live and this record should not claim either.

## The needle was 155 characters outside the window

Building that small repository started with checking where the planted defect actually sits. It never needed
building. **The defect is at character 12,155 of a 12,263-character file, and the paid read cap is 12,000.**

Measured by calling the real function rather than by arithmetic over the file, because the cap is a `String.slice`
in characters while the obvious way to compute it is `Buffer.byteLength` in bytes, and this codebase's prose is
full of em-dashes:

```
readRepoFile(probe, "src/roster.mjs", 12000)
  length     : 12263 chars   truncated: true
  returned   : 12000 chars
  defect ("min: 0") in what the agent gets?  NO
  in the full file?                          YES
  the read ends: "…both of which FAIL on -Infinity rather than passing. This closes th"
```

It stops mid-word, 155 characters short of the line that decides the return value. **No round could have found
that defect by reading the file.** Only a search could — `read_repo` with a term in `command` greps the whole file
— and the prompt says exactly that, in words, on every truncated read.

**So the scale-versus-judgement fork was never a real fork.** Five rounds tested a hypothesis that could not be
tested, and this record's "both explanations remain live" was itself too generous: a third explanation dominated
both and nobody had measured it.

### What the five rounds actually looked at

From Bureau's own audit log rather than from memory — `action_type='read_repo'`, after the defect commit:

| | |
|---|---|
| repo reads across the five rounds | **78** |
| of those, touching `src/roster.mjs` | **0** |
| searches issued | 50 |
| searches against `src/server.mjs` | **41** |

So both failures are real and they compound. Attention collapsed onto one file — 41 of 50 searches — and the one
file holding the defect was never opened; and had it been opened, the defect was outside the window anyway.

_Checked against a wrong answer first. A tally over the whole audit table said `roster.mjs ever read? YES`, which
would have overturned the record. Dating it showed the read was 2026-08-10 against the **authorization** clone,
a day before the `min: 0` commit existed. A count with no time filter answered a question about a different
repository._

### The fix: a truncated read now says which declarations lost their body

The outline already listed every declaration in the whole file regardless of the cut — that is what makes
"X is not in this file" answerable from a prefix, and it works. What it could not answer was **visibility**. An
agent shown 12,000 of 12,263 characters was told the file was cut off and told that `workloadSpread` exists at
line 195, and from those two facts cannot work out that the end of that function is in the 263 characters it did
not get. *"Cut off after 12,000 of 12,263"* is a fact about the file; the agent reasons in declarations.

`markOutlineVisibility` tags every symbol `seen` / `partial` / `unseen`, and the read reply renders it. On the
real file, unchanged, with the real cap:

```
  116: export function rosterReview(db, seasonId) {
  195: export function workloadSpread(db, seasonId) {   <-- body CUT OFF: you have NOT seen the end of this one

1 of those is wholly or partly outside what you were shown, and the END of a function is where its return value
is decided. If any of them matters to what you are looking for, SEARCH it rather than re-reading: …
```

One line in that outline carries a marker, and it is the one holding the defect.

**`repoReadReply` was extracted from the turn loop so the test asserts on the string the agent is handed.** The
marker was correct and unreachable from any prompt for about an hour while I wired it, and a test grepping
`server.mjs` for the wiring would have passed the entire time — the same proxy-assertion failure this document
records five other instances of. Controls in the suite: a **complete** read carries no cut-off language at all
(otherwise the marker fires on everything and means nothing), the last declaration of a whole file is not
mistakenly reported partial, and the function that *was* fully shown carries no marker.

Suite: **832 assertions**, up from 819.

### And the judgement half, for 21 cents

With visibility eliminated as a confound, the remaining question is answerable without a repository at all: hand
the model `workloadSpread` whole, plus every assertion in the suite that touches it, and ask. 2×2 — defective
against the **correct** version as a control, with the lens and without it — three samples a cell, then a longer
control run.

| | named the defect |
|---|---|
| lens + defective | 2 / 3 |
| lens + correct *(control)* | 0 / 3 |
| no lens + defective | 2 / 3 |
| no lens + correct *(control)* | 0 / 3 |

Pooled with the follow-up control run, same model and prompt shape:

| | calls | named the defect | blank |
|---|---|---|---|
| **defective** | 8 | **5** | 3 |
| **correct** | 12 | **0** | 11 (+1 explicit `NOTHING`) |

The claims are exact, and one of them supplies the lens unprompted:

> *"In the non-empty branch `min` is hardcoded to `0` instead of `Math.min(...counts)`, so the returned minimum is
> wrong for every populated roster **yet no assertion checks `min` when `counts` is non-empty**."*

That second clause is the `what-would-it-accept` question, produced without being asked it — and the no-lens arm
found the defect at the same rate, so for this defect the lens is not what was missing.

**Judgement is not the bottleneck. Attention is.** Five rounds, ~$3.00, spent 41 of 50 searches on one file and
never opened the one holding the defect. Every mechanism improvement so far — cheaper reads, the collapse, the
digest — makes looking cheaper. None makes it *broader*, and breadth is the thing that was missing.

**The blank rate is evidence, not noise.** Every blank reply spent exactly `out=4000`, the whole token budget, and
returned no visible content; the fastest correct answer used 2,658 tokens and 47 seconds. On code with a defect the
model converges and stops. On correct code it reasons to the end of its budget and emits nothing — 11 times out of
12, with **zero false positives**. A silence that costs the full budget is a different event from a silence that
comes back quickly, and only the per-call token count distinguishes them.

_Two corrections earned here, both from checks rather than from care._ A guard asserting the control code did not
contain `min: 0` fired on the **correct** version — its empty-list branch legitimately returns `min: 0`, and the
defect is in the second return. The guard was wrong, not the extract. And the blanks were first attributed to
Latch's 120-second timeout on the strength of one `ok=false`; raising `maxTokens` to 16,000 to test that made
**every** call time out, because a larger budget lets the model spend longer. Printing `out=` per call showed the
original blanks were all exactly at the 4,000 cap. Both explanations were real, in different regimes, and the
tell was a column I nearly did not print.

### The file-coverage ledger

A round recorded `{ lens, at, confirmed, dryAfter }`. **Lens coverage was tracked; file coverage was not tracked at
all** — so "no round ever opened `src/roster.mjs`", the single most useful fact about five dry rounds, was not on the
run, not in any event, and had to be recovered from the audit log afterwards. The lens register already orders lenses
by coverage because coverage beats exploitation; the same argument applies to files, and `emit(run, "repoRead", …)`
was already the one choke point every read and search passes through.

- **`noteRepoRead(run, file)`** records at that choke point. A directory listing, a whole-repository search and a
  blank are deliberately *not* coverage — counting them would let a round call itself thorough for having typed
  `read_repo` with an empty title, which is the move a dry round actually makes.
- **The map is now rendered per round, not per run.** The repository is still *walked* once — that is the expensive
  half — but what a round has opened changes between rounds, so a map rendered once cannot show it.
- **Coverage-first ordering.** Unopened files sort above opened ones, opened ones are marked `(read)`, and the header
  says the fraction: *"Reporting 'nothing found' after opening 5 of 87 files is a statement about 5 files."*
- **The round record and a `coverage` event carry it**, and the event *names* what was never opened rather than only
  counting it — a number is something a reader acknowledges, a list is something they act on.

Two assertions had to change and the reason is worth keeping: `chk('runGated computes it once per run',
src.includes('digest: digestText(dg0)'))` asserted the **rendering call verbatim**, so it failed on a change that left
the property it names true. It now asserts the walk, with a control that there are exactly two `repoDigest(` calls in
the file. Same proxy-assertion class this document records six other instances of.

And the wiring is tested by driving the real loop, not by grepping for it: a worker opens one file in round one, and
the test reads what round **two** is handed. `digestText` and `noteRepoRead` were both correct and unreachable from
any prompt for the better part of an hour while being wired up, and a source grep would have passed throughout.

Suite: **852 assertions**, 12 suites green.

### The ledger against a real model, and what the round actually showed

Two rounds, paid tier, `kimi-k2.6`, against the same probe repository. Round one has opened nothing, so its map is
identical to the one five earlier rounds saw; only round TWO can show the ledger. Recounted from the transcript,
because the first tally split search labels on `:` and reported every search as a distinct file:

| | actions | on `src/server.mjs` | distinct targets |
|---|---|---|---|
| round 1 — `what-would-it-accept` | 16 | **14 (88%)** | 3 |
| round 2 — `collector-blind` | 16 | **0** | 5, plus five whole-repository searches |
| the five-round baseline | 50 | 41 (82%) | — |

**The ledger itself is verified live**: coverage went `3 → 6 of 87`, the numbers reached the round record and the
`coverage` event, and round two never returned to the three files marked `(read)`.

**Its effect is NOT established, and the reason is a confound I introduced.** Round two ran a different lens, and
`collector-blind` is inherently repository-wide — "find a check that passes vacuously on an empty collection" sends
an agent to `.every(` and `.some(` everywhere. Two variables moved at once, so the spread cannot be attributed to
the marking. The clean version is the same lens twice, or a control round with the marking suppressed.

Worth recording separately: round one ran **`what-would-it-accept`** — the lens the planted defect was chosen to
need — and spent 88% of its actions on authorization inside `src/server.mjs`. That is the fourth time that lens has
gone to authorization. And `src/roster.mjs` is now untouched across **seven** rounds.

### A hunting round that could not read the repository, and cost $0.36 finding out

The first attempt at the round above opened **zero** files in two rounds and 505 seconds. The agent reached for
`read_file`, then the company's deliverables, then `github_file`, then a raw GitHub URL, and finally said: *"I cannot
examine the repository because read_repo is blocked."* It was right, and it behaved correctly throughout.

The hunting prompt advertises `read_repo` whenever `guardrails.findingRepo` is set — **without asking whether the
agent is permitted to use it.** That agent's `allow` list named ten actions and `read_repo` was not among them; the
four it reached for all were. Same shape as the `other` action that was advertised and unimplemented, and it costs
more, because a hunt with no repository access cannot produce a finding the gate would accept: the gate proves a
claim by running a check against that repository.

`runHunt` already refuses when no repository is configured. It now refuses just as loudly when the agent cannot read
the one that is, before a turn is spent. The permission rule is one exported `agentMayRun`, used by both the turn
loop and the new pre-flight — two copies is how a pre-flight comes to disagree with the thing it predicts.

_And the setup error underneath it is worth as much as the fix._ I created a fresh workspace believing it meant a
clean slate. It meant a **different company**: twelve default agents, and the hunt picked an "Assistant" with a
restrictive allow list, where the baseline workspace holds one purpose-built "Software reviewer" with none. A fresh
workspace is not a controlled one. _(It was not even a fresh workspace — see below. It never existed at all.)_

### The planted defect, found and confirmed — and a $1.40 comparison of a company with itself

The controlled version: two arms, the lens forced to `what-would-it-accept` in every round, differing only in
`guardrails.coverageMap`. **Arm A round one registered a finding the gate accepted:**

> *"workloadSpread reports min=0 even when every volunteer has positive assignments"* — `src/roster.mjs:213`

That is the planted defect. It is the **first confirmed finding on a green repository** in this work, after seven
rounds that never opened the file, and it arrived under the lens the defect was chosen to need.

**Arm B found it too, and the gate refused every attempt — correctly.** Six `register_finding` calls, and the
reasons are the rules doing their job:

```
the anchor text appears 2 times, so it does not identify   x3
the anchor text was not found
the fix does not make the check pass                       x3
```

`min: 0` really does appear twice in that function — the empty-list guard and the defective return — so the
ambiguous-anchor refusal fired on exactly the case it was written for. Both arms located the defect; the anchor
rule decided which one could land it.

**The A/B itself is void, and the harness said so before I did**, ending with
`*** LENSES DIFFER — the comparison is void, same flaw as last time ***` because arm B's first round ran
`inspect-identity-elements`. The cause was not the lens switch: **the two arms were the same company.**

`x-workspace` fell back to `default` for any name that did not exist, silently. `cov-on` and `cov-off` were never
created, so both arms wrote guardrails, an agent allow list and a budget onto the default company, both ran there,
and the second overwrote the first — while every readback confirmed the settings, because the readback landed in
the same place. Arm A's critic then proposed a new lens, which arm B inherited. A wrong answer, delivered as 200.

That fallback is now a **400**. The test asserting it — *"unknown workspace id falls back to default (never a
phantom company)"* — stated an intent worth keeping, and refusing satisfies it just as well: refusing creates
nothing either. It simply does not also answer a question about a company nobody asked about. A control asserts a
real workspace still resolves, so the guard is not refusing everything.

_The three earlier rounds above ran under `hunt-coverage-1`, which also never existed. They were in `default` the
whole time — which is why the audit rows say `ws: default`, and why "a fresh workspace" is the wrong name for what
happened. The only workspaces that have ever existed here are `default`, `4water-scheduling-739c` and
`hunt-funded-9e60`._

### The comparison, finally valid — and the marking shows no effect

Third attempt. The first two died on setup rather than on the question, so this one proves its preconditions before
spending, and every proof can fail: workspaces **created** and their server-assigned ids captured; an unknown
workspace still answering **400**; a **canary** written to one arm and read back absent from the other; the arms
asserted to still differ *after both setups* — the check attempt two lacked; one lens of eight enabled, read back
through `off` rather than `enabled`, which returns 200 and does nothing; and `read_repo` confirmed in the allow list.
The harness also declares its own verdict void if the lens varies, instead of leaving that to a reader.

`VALID — one lens throughout both arms.`

| | round 1 | round 2 | covered by the end |
|---|---|---|---|
| **A — marking ON** | 16 actions, 6 targets, **63%** on `src/server.mjs` | 14 actions, 5 targets, **29%** | 6 → **9** of 87 |
| **B — marking OFF** | 19 actions, 6 targets, **68%** on `src/server.mjs` | 16 actions, 8 targets, **50%** | 5 → **11** of 87 |

Round one is the internal check: neither arm has any marking yet, and they behave alike (63% vs 68%). That is what
makes the arms comparable, and it is the claim the previous two attempts could not make.

**The marking shows no measurable effect, and the two signals point opposite ways.** Round two is less concentrated
on `src/server.mjs` with the marking on (29% vs 50%) — and the *control* covered more of the repository (11 files
vs 9) and reached more new targets (6 vs 4). One run per arm cannot separate either difference from run-to-run
variance. **Neither arm found the planted defect, and neither opened `src/roster.mjs`.**

So the ledger is verified as an instrument — it records accurately, the map re-renders per round, the switch works
in both directions — and **unproven as an intervention**. Settling it needs repetition, roughly five runs per arm at
about $1.15 each, and that is a spending decision rather than a technical one. Recorded as unproven rather than
quietly dropped, because a mechanism that is built, tested and ineffective is the easiest kind to keep believing in.

_Cost of the three attempts: $0.36 (agent could not read the repo), $1.40 (both arms were the same company), $2.28
(valid). The first two bought defects rather than an answer — the read_repo pre-flight and the workspace 400 — which
is a fair trade, but they were not what the money was for._

### The gate had been red for ten days and could not say why

Four commits landed against a red CI while the notification said only *"All jobs have failed"*. Three separate
instruments were blind at once:

1. **`run-all.mjs` printed the last 25 lines of a failing suite.** The suites print one line per assertion — `units`
   prints over eight hundred — so the tail is whatever ran last. A planted failure at line 83 of 1,999 was reported
   as three consecutive ticks under the heading `SUITE(S) FAILED`. Now it filters for failure markers and falls back
   to the tail only when none is found, which a crash or a syntax error needs.
2. **The workflow forwarded those 25 lines**, so the annotation inherited the blindness.
3. **The log needs a signed-in session with admin rights; an annotation does not.** Both repos now echo the failure
   into an `::error::` annotation, which is how this was diagnosed at all.

The failure itself: two assertions asserted **Windows path syntax as if it were universal**. On Linux `\` is an
ordinary filename character and `C:` an ordinary directory name, so `src\..\..\..\secret` and `C:/Windows/win.ini`
resolve to one strangely-named file *inside* the repo. They could not pass on the machine the gate runs on, and
passed on the machine they were written on. Reproduced without a Linux box by running `repoPathSafe`'s own arithmetic
against `path.posix`, which also settles the question that matters: **nothing escapes the repository on either
platform.** This was a test asserting `path.sep`, not a security hole. The assertions now state the invariant and let
the mechanism differ — refusal on win32, containment elsewhere.

Found in the same file while chasing it: `chk("the temp dir is removable after stop()", !readdirSync(tmpdir()).includes(dir))`
compared an **absolute path** against readdir's **basenames**, so the needle could never be in the list and the check
could never fail. It now asserts the directory is gone, with a precondition that it was there first.

Cumulative paid spend across the session: **~$14.79** (the hunting attempts cost $0.36, $1.22, $1.40 and $2.28).
