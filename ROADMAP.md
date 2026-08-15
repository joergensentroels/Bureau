# Bureau — Roadmap

Bureau is a management-sim orchestrator: hire a company of AI agents, point them at goals, and
they take **real, approval-gated actions** through the Latch backend. Latch is the security
boundary; Bureau is the control surface.

_Forward-looking only — the detail of what's shipped lives in the code, the tests, and git history._

---

## Next

**The repo went public on 2026-08-01, which changed what "valuable" means.** The feature roadmap and the
operational-durability work are both done. What follows is ordered for **legibility to strangers**, not
feature parity.

_Rewritten 2026-08-15, because this list predated the entire **review subsystem** — hunt mode, the
finding/probe gate, the lens register, the question queue, the declined-check register and the scope
guardrail all landed between 2026-08-06 and 2026-08-15 and appeared in no document but TESTING.md and the
git log. See **Shipped → The review subsystem** below for what exists and what it has and has not yet
shown. Two items above were not stale but **false**, and are restated rather than deleted: a roadmap that
quietly drops a wrong claim teaches nobody why it was wrong._

  1. **The floor firing in the LIVE loop, and a recording of it.** _Narrowed on 2026-08-15: this item used
     to say "the README argues the differentiator in prose", and that has been false since 2026-08-02._
     `tools/demo-floor.mjs` sweeps every autonomy tier × policy effect × `autoApprove` against the real
     `decideApproval()` and exits non-zero if a hard-floored action is ever auto-approved; its transcript
     **is** a README section; and `test/readme-demo.test.mjs` pins that code fence to the tool, so the
     numbers in it cannot drift quietly. The claim is already evidence rather than prose. What is still
     open is narrower and worth stating exactly: **that sweep is `decideApproval()` in process.** Nothing
     demonstrates the live chain — an agent proposing `shell`, the floor refusing at trusted tier, the
     operator approving in Latch, Latch executing — and there is no recording of any of it. Twenty seconds
     of asciinema is still the cheapest item here; it is now an *addition* to the proof, not a substitute
     for a missing one.
  2. **Browser UI — Playwright is DECLINED, not pending.** _This item ranked it second and called the UI
     "the largest untested surface"; TESTING.md recorded the opposite decision on the same day, and the two
     documents gave opposite instructions for two weeks. TESTING.md is the one that is right._
     `test/ui.test.mjs` shipped 2026-08-02 in the **pure** set: the inline `<script>` is really parsed, and
     every literal `#id` lookup must resolve to an id defined somewhere in the file — the single most likely
     way this UI breaks, because a misspelled selector throws nothing, fails no syntax check, and just
     returns `null` onto a silently dead control. `node test/run-all.mjs --ui` holds the throwaway server
     open on a disposable token so the page can be *looked at* without assembling a harness, which is how
     the panels shipped in this stretch were reviewed. **Playwright is declined on a stated trade:** it
     needs a live Bureau *and* a browser dependency in a repo whose zero-dependency property is a design
     feature, CI has neither, so it would live outside both gates — and a ~150 MB Chromium download changes
     the clone-and-run story. That is an owner decision, recorded so it stops being re-proposed. What
     remains is manual and cheap: load the page under `--ui`, read the console and network log. _And know
     that an automated browser is not a browser — a driven browser throwing on `window.prompt` produced a
     completely convincing fake bug once already; the note is in TESTING.md._
  3. **The review subsystem's open question is ATTENTION, not judgement — and it was measured.** The
     machinery is built and works (see Shipped): a round lists a repository, reads real source, forms a
     hypothesis, checks it, and either registers a finding the gate proves or says plainly that the lens
     showed nothing. What it does not reliably do is **look in the right place**. Five rounds against a
     green 4water spent 41 of 50 searches on one file and never opened the one holding the planted defect;
     three separate rounds under `what-would-it-accept` all went to authorization because that lens reads
     as an authorization question to a model looking at a web app. Judgement was eliminated as the cause
     for 21 cents: handed the defective function whole, the model named the defect **5 times in 8** and
     produced **zero false positives in 12** runs against the correct version, with and without the lens.
     - **The mechanisms that make looking cheaper are done and did not fix it** — the outline, the
       visibility markers, `collapseReads` (57% off billed tokens), the whole-repo digest (87 files in
       ~2,000 tokens), the file-coverage ledger. None of them makes looking *broader*.
     - **The coverage marking is built, tested, and UNPROVEN as an intervention.** A valid A/B (both arms
       proved distinct first, one lens throughout) showed no measurable effect and two signals pointing
       opposite ways. Settling it costs roughly five runs per arm at ~$1.15 each — a spending decision.
       Recorded as unproven rather than quietly dropped, because a mechanism that is built, tested and
       ineffective is the easiest kind to keep believing in.
     - **The scope guardrail is the current best answer** and it is mechanical rather than persuasive:
       `guardrails.scopeFiles` restricts what `read_repo` may open at all, and a scope of ≤20 files raises
       the read cap from 12,000 to 60,000 characters so a bounded file set is read WHOLE. That removes
       both failure modes at once — wandering, and reasoning from a prefix — at the cost of someone
       choosing the files.
  4. **MCP elicitation — scoped 2026-08-02, and it is NOT prototype-sized. Read this before starting.**
     The idea stands: MCP has a standard mechanism for a server to pause and ask *the human*, which is what
     `requiresCeoAlways` already does, and implementing it would let an external client (Claude Desktop)
     drive a run and receive the approval prompt in its own UI. It remains the only item where the feature
     and the pitch are the same sentence, while the rest of the space removes human checkpoints. But:
     - **Elicitation requires an in-flight call, and Bureau's tools are fire-and-forget.** `beginRun()` is
       synchronous: it registers the run, kicks execution off inside the workspace context, and returns.
       `start_run` / `run_sop` therefore answer `{runId}` in milliseconds, while the approval need arises
       minutes later with **nothing in flight to elicit within**. Making this work needs a blocking
       `run_and_wait` variant holding an HTTP POST open for the length of a run — against the SSE-watch
       design, and fragile to any client's timeout. That is a design change, not a prototype.
     - **⚠ The obvious shortcut is a floor breach, and it looks like a feature.** "Just expose
       `pending_approvals` + `decide_approval` as tools" reads as equivalent to deciding in Latch. It is
       not: **MCP tools are invoked by the MODEL, not the human.** A `decide_approval` tool hands an LLM the
       power to approve a hard-floored `shell` — the exact escalation `mcp_call` is hard-floored to prevent,
       inverted and handed back. Reads are fine; **the decision must never be a tool.** Guarded now by
       `test/mcp-floor.test.mjs`, which pins the tool list EXACTLY so adding any tool trips the test and
       forces the question to be answered deliberately.
     - **That asymmetry is the whole reason elicitation is the interesting mechanism:** it routes to the
       *user*, a tool routes to the *model*. It is the only MCP-native way to do this without breaching the
       floor — which makes it more valuable and strictly harder, not less.
     - **Spec churn is real:** SEP-2322 (revision 2026-07-28) replaced server-initiated requests with a
       `resultType: input_required` + `inputRequests` pattern. Bureau's `/mcp` is tools-only, so nothing is
       broken meanwhile — but it echoes back the client's requested `protocolVersion`, i.e. claims a
       revision it has not implemented. One-line honesty fix, not a roadmap item.
  5. **Land the 4water scheduling case.** Chosen on 2026-08-01 as Bureau's first real external case,
     explicitly *before* publishing — and publishing went first. The ordering slipped, so this is now the
     most valuable non-code item on the list: one real external deployment is worth more than three
     features when the repo's job is to be evidence.
  6. **Durable / resumable runs — on the list, deliberately not started.** Checkpointing so a crash resumes
     mid-run is table stakes across LangGraph, CrewAI and AutoGen; Bureau has none, and a restart silently
     loses in-flight runs. Coherent with the unattended-service work, and the honest counterweight is that
     runs are minutes of local-model time, so the loss per crash is small. **Write the trigger down rather
     than carry it as vague debt: build this when runs get long or paid-heavy enough that losing one costs
     real money.**

**Recommended against, with reasons** (so these do not come back as open questions):

  - **Session-scoped authorization** ("approve this agent for the next 30 minutes") is a real 2026 pattern
    and it directly weakens the thing the README calls the product. The floor is per-action on purpose.
  - **LangGraph-style graph-API parity.** Competing on someone else's axis, where Bureau loses and gains
    nothing. The hierarchy plus the floor is the product.

**Standing observation rather than a task:**

  - **Off-machine backups are an operator decision, not a default.** `tools/backup.mjs` protects against a
    corrupt write, a bad migration, an accidental delete. It does **not** survive losing this disk, because
    the snapshots are on it. Fixing that means deciding where the operator token and the provider key are
    allowed to live; the tool deliberately refuses cloud-synced folders rather than quietly choosing for you.

_Vocabulary worth knowing, since Bureau demonstrates several of these without using their names: **CIBA**
is the standard term for out-of-band human approval (what Latch-on-a-phone is); the 2026 agent-identity
landscape is MCP OAuth 2.1 under Linux Foundation governance, MCP-I / KYA-OS at DIF, Microsoft Entra Agent
ID, and the CSA Agentic Trust Framework._

Closed on 2026-08-01:

  - ~~GPU under SYSTEM is unproven.~~ **PROVEN: session 0 does not cost the GPU.** `qwen3:8b` loaded on the
    boot-task Ollama reports `size_vram` **equal to** `size` (5.20 GB, 100% resident, CUDA on the NVIDIA card
    with 14.2 GiB free), generating ~75 tok/s warm — GPU-class; a CPU fallback on an 8B model is low single
    digits. Two traps worth remembering. The `AMD driver is too old. Update your AMD driver to enable GPU
    inference.` line in every server log is Ollama probing the Ryzen's **integrated** graphics and skipping
    it before selecting CUDA — reading that as the answer inverts it. And the *cold* measurement looks
    catastrophic (0.4 tok/s) because 23.8s of it is loading 5 GB into VRAM for a 2-token reply; only the warm
    number means anything.
  - ~~**Running Ollama as a SYSTEM task is safe.**~~ It is, but **only with the tray app out of Startup**, and
    finding that out cost an outage. The tray app is also the auto-updater. With the boot task holding
    `ollama.exe` open, the updater could not replace a file owned by a process it lacks the rights to stop
    (`DeleteFile failed; code 5`), and it **rolled back by uninstalling** — deleting
    `lib\ollama\llama-server.exe`. The running server kept answering `/api/tags` from memory, so `-Verify`,
    the port checks and the model list all stayed green while **every inference returned 500**. A liveness
    check that only proves a process is listening will not catch this; loading a model is the only check that
    would have. Updating Ollama is now a deliberate operator action — the installer prints the order.

  - ~~Anthropic's OpenAI-compatible endpoint as Latch's `fallback`.~~ **Declined by the operator, and the
    reasoning is worth keeping.** It was only ever proposed as the legitimate substitute for wiring a Claude
    *subscription seat* into Bureau (which stays declined — a seat is licensed for interactive human use, and
    a 60s scheduler plus webhook triggers means nobody is driving). Once the seat is off the table, paying
    per-token for a second paid fallback buys nothing over the Kimi/Moonshot one already configured: there is
    a single fallback slot, and `orchestrationRouting` already sends only the JSON-critical calls to it.
    Recorded because the *transport* question was settled and should not be re-investigated: Latch POSTs to
    `${baseUrl}/chat/completions` with `authorization: Bearer <apiKey>`, which is exactly what Anthropic's
    compat layer expects, so it remains a pure config change if the calculus ever changes.

Closed on 2026-07-31:

  - ~~Nothing prunes GitHub refs for closed-not-merged PRs.~~ `GET /api/github/branches` now reports
    `prunable` + `reason` per branch and a `prunableCount`. Deliberately a **read**: the operator sweeps with
    the existing `POST /api/github/delete-branch`, because deleting a ref is outward-facing and awkward to
    undo, and a scheduled job quietly deleting branches is not something anyone asked for. The rule is
    narrow on purpose — a branch qualifies only if a pull request actually *finished* on it, so
    work-in-progress with no PR yet is never swept. Decision extracted to `github.mjs` and unit-tested
    (`npm test` → `test/github-prune.mjs`) because `prunable: true` cannot be observed from outside without
    creating and closing a real PR; the live endpoint was confirmed 200-with-correct-shape against the
    sandbox, where every branch is the default one.
  - ~~No operator-token rotation procedure.~~ `Rotate-OperatorToken.ps1` + the checklist in SECURITY.md. The
    trap it exists to prevent: Bureau caches the token at boot, so rotating the file without restarting
    Bureau leaves the old token working.

**In flight — Parallel execution.** Stage 1 shipped (2026-07-23, commit `a16fbb1`): opt-in
`run.parallel` / **⚡ parallel reports** toggle runs a manager's sibling reports concurrently through
a bounded semaphore (`ORCH_MAX_PARALLEL`, default 3), with no cross-sibling handoff — the manager's
synthesis step integrates their work. Sequential stays the default. Live-verified 2026-07-23: a
company run completed with siblings dispatched concurrently (3 sub-tasks at the same timestamp) and a
deliverable produced.

**Speedup measured 2026-07-31 (`node eval/parallel-eval.mjs`) — the July "4.6x" was a confound, and the
honest answer on the local model is that parallel buys nothing.** Across 4 sequential/parallel pairs where
decompose happened to produce the SAME 4 sub-tasks in every run (so no confound at all): sequential
median ~118s, parallel median ~128s — **about 0.92x, i.e. slightly slower.** The concurrency itself is
confirmed working: sub-tasks dispatched within the first second are **1 for sequential vs 3 for parallel**
(= `ORCH_MAX_PARALLEL`). So the dispatch layer does exactly what it claims, and the gain is eaten because
one ollama instance serialises the inference behind it — while parallel additionally gives up
cross-sibling handoff, so siblings can duplicate reasoning the sequential path would have reused.

  - **Keep parallel opt-in and off by default.** That was already the case; this is now a measured
    position rather than a guess.
  - **Stage 2 — dependency-aware decompose: PAUSED, moved to the backlog by the operator (2026-07-31).**
    Not blocked and not abandoned — the reliability gate passed and the measurements below stand. It is
    parked because the value case is thin, and the one thing that should un-park it is a **correctness**
    observation, not an appetite for speed: real runs showing siblings damaged by a missing predecessor's
    output. Everything needed to resume is recorded here; nothing needs re-measuring.
    - `node eval/run-eval.mjs --type=decompose --reps=8 [--dependson]`, same cases, same ladder:
      baseline **50%** single-shot / 75% effective / 75% schema, p50 21.8s → with `dependsOn` **72%** /
      75% / 75%, p50 **8.2s**. Asking for the extra field made the flakiest call parse on the first rung
      MORE often and roughly halved median latency — the opposite of the feared regression. Likely
      mechanism: a more concrete schema leaves less room to wander into a `<think>` block.
    - The field is also **usable, not merely present**: 100% of tasks carry `dependsOn`, and 100% are
      integer arrays referencing *earlier* tasks (a forward or self reference would parse and still be
      unexecutable). Graphs are stable and sensible — `0:[] 1:[0] 2:[0,1]`.
    - **But the value case stayed weak.** Blanket parallel is 0.92x locally and already delivers ~1.7x on
      paid, and **dependencies are ALREADY conveyed implicitly by task order** — the decompose prompt says
      "put the dependency FIRST — each person is given the finished work of everyone listed before them".
      Stage 2 would make that explicit, not new. So it is a scheduling refinement on top of a 1.7x that
      exists, not a way to unlock parallelism.
    - **Recommendation: don't build Stage 2 for its own sake.** The honest reason to revisit it is if
      real runs show dependent tasks being damaged by blanket parallel (siblings missing a predecessor's
      output) — that is a correctness argument, and a better one than speed.
  - **PAID TIER SETTLED 2026-07-31 — parallel is worth ~1.7x there (range 1.57–1.73x), against 0.92x
    locally. Total cost of the measurement: $1.48 over 5 pairs.**
    - **The answer:** 3 matched pairs (equal sub-task counts, no provider error, no cap hit) gave
      1.57x and 1.73x on 4-sub-task runs, plus 2.29x on an 8-sub-task run whose sequential arm hit the
      spend cap and is therefore excluded. **Quote ~1.6–1.7x.** The median of per-pair ratios is the right
      statistic here, not the ratio of medians — with n=3 the latter degenerated into echoing one pair.
    - **The first, exciting 2.36x was contaminated** by a Moonshot overload error letting part of the
      parallel run fall back to the ~10x faster local model. Repeating it under a strict filter cut it to
      ~1.7x. Worth remembering next time a single flattering pair shows up.
    - **Why paid differs from local at all: a paid sub-task takes ~300s against ~30s (~10x).** Locally
      there is simply no latency to hide, which is why blanket concurrency measured 0.92x there.
    - **Cost is roughly a wash, NOT a penalty** — and this corrects an earlier claim of "+26%" made from a
      single pair. Across pairs, parallel ran +26%, −11% and −20% on spend: no reliable direction. The
      no-cross-sibling-handoff design should cost extra tokens in principle, but it does not show up
      consistently at this sample size.
    - **Operational:** 3 concurrent Kimi requests is enough to trip `"The engine is currently
      overloaded"`. `ORCH_MAX_PARALLEL` is the dial; consider 2 for paid-heavy work.
    - **Cost model:** billed paid tokens run ~1.75–2x the run's own token figure, because every turn
      resends the growing history. Budget **~$0.15/run** for a 4-sub-task company run.
    - **So: enable `parallel` for paid-heavy runs, leave it off for local ones.** That is now measured
      rather than assumed, in both directions.

**The eval gate is GREEN — the red was machine load, not a regression (resolved 2026-07-31, `75c343c`).
Do not re-baseline.** Three runs of `criteria.singleShotRate` on identical code and cases, hours apart:
**78%** (n=32), **80%** (n=20, p50 9173ms), **100%** (n=60, p50 4227ms). The two low scores were taken
while the test suite, the live e2e and a server restart competed for the same Ollama; the 100% run had the
machine to itself. `effectiveRate` and `schemaRate` were 100% in all three, so the retry ladder absorbed
every first-shot miss and no run ever received invalid JSON.
  - **Run the gate on an otherwise idle machine, or its verdict is about your CPU.** It now records `n` and
    `p50ms` per call-type and flags a p50 gap of ≥1.5× as non-comparable, so nobody re-baselines over a
    load artifact or hunts a prompt regression that was never there.
  - The earlier "the inference backend changed" hypothesis is the weaker one: all three of these runs were
    the same backend within hours of each other.
  - Baseline VALUES are all confirmed — criteria 100/100/100 at n=60, verify 100/100/100, decompose
    50/75/75. What the baseline lacked was not better numbers but the context to interpret them.
  - **Still true: never `--save-baseline` to turn a red gate green.** That erases the only signal something
    moved. Re-baselining is the operator's call and belongs in a deliberate commit.

The remaining backlog, roughly by value (competitive-gap analysis, 2026-07-22):

- **Semantic memory — the paraphrase miss was investigated and CLOSED as "no change".** Both hypotheses
  were wrong, and every proposed fix measured the same or worse. Written up here so nobody re-opens it on
  a hunch; re-runnable via `node eval/recall-eval.mjs`.
  - Not the QA-criteria boilerplate: embedding only the objective's first line moved the target entry
    from rank #7 to #8 of 39 — no better.
  - Not the missing `nomic-embed-text` task prefixes (`search_query:` / `search_document:`): adding them
    moved the target from #7 to **#10**, i.e. worse for this query, though it does tighten scores
    slightly elsewhere.
  - Real mechanism: the target ranks #7 semantically, so it *does* reach fusion, but loses to keyword
    hits sitting at lexical ranks 1–2. Yet **suppressing those keyword hits does not help overall** —
    measured recall@3 across 12 labelled queries: shipped equal-weight RRF **10/12**, weak-lexical-hits
    dropped 10/12, semantic weighted 2× or 3× **9/12**, semantic alone 9/12, lexical alone **5/12**.
  - Conclusion: the shipped configuration is the best of everything tried, weighting the vectors higher
    actively hurts, and the lexical/hybrid gap (5/12 → 10/12) is the result that matters. The two
    remaining misses are the tail of a small corpus, not a bug — tuning them away would cost recall
    elsewhere, which is precisely the trap.
  - Deliverable embedding and chunking: both **done**, see Shipped.
- **Outbound integrations** — ✅ **done as of 2026-07-31.** `github_file` / `github_repo` (publish), plus
  `read_issues` / `github_issue` / `github_comment` / `github_pr` — the loop closes in both directions:
  agents read a real backlog, respond on it, and propose finished work as a reviewable PR. Latch holds the
  token throughout. Verified with an agent opening a real PR end to end. See Shipped for the design calls
  (posting is hard-floored, committing a file is not; issue text is untrusted third-party input).
  **Slack was dropped on purpose** — agents coordinate through the internal Plan (shared state), not a chat
  channel; for *human* digests, point the existing notify-webhook at a Slack incoming webhook yourself.
  - Possible follow-ons, none needed for the current shape: reading PR state (open/merged/closed) back
    into a run, and multi-commit PRs accumulated across turns.
  - **Operator setup outstanding:** the PAT needs **Administration: Read and write** if you want Bureau to
    flip repo settings such as "Automatically delete head branches" (`POST /api/github/repo-settings`
    currently 403s). Everything else the connector needs is granted. `GET /api/github/doctor` reports which
    capability is missing — and lists Administration as *unprovable by any read* rather than guessing.
- **Office-view revamp** — the isometric office is functional (renders from `public/assets/iso/`),
  but its visual design was parked. Pure presentation, no behavior change.
_(Deliverable delete is complete — API and UI both shipped, see below.)_
- **Reboot survival — FIXED 2026-07-31 (`Install-Autostart.ps1`), needs one elevated run + a real reboot
  to confirm.** All three processes lived in the **per-user Startup folder**, which only fires after an
  interactive logon — and this machine has no auto-login. So an unattended reboot stopped at the lock
  screen with Bureau, Latch and Ollama all down and no way to start them remotely. Tailscale *is* a real
  service, so the symptom is a **502 from a hostname that resolves perfectly** — which reads like an app
  crash rather than "nothing ever started", and is why this went unnoticed since 2026-07-19.
  - Fix: three At-Startup Scheduled Tasks running as **SYSTEM** (no stored password, no logon needed),
    with restart-on-failure and no execution time limit (the default 3-day cap would silently kill a
    long-lived server). Run `.\Install-Autostart.ps1` from an **elevated** shell; `-WhatIf` previews and
    `-Uninstall` reverts. The Startup shortcuts are left in place until a real reboot proves the tasks.
  - **Two path traps that make a naive "just make it a service" attempt fail here**, both handled
    explicitly: as SYSTEM, `os.homedir()` is `C:\Windows\system32\config\systemprofile`, so Bureau would
    not find Latch's `auth.json` (and `exit(1)` on boot) and Ollama would report no models. `LATCH_DATA` is
    now pinned from the repo layout inside `Start-Bureau.ps1`, and `OLLAMA_MODELS` is passed by the task.
  - **Deliberately NOT auto-login.** It is the other fix, and it means the account password in the registry
    plus an unlocked desktop on boot — a physical-security trade for remote availability. That is the
    operator's call to make knowingly, and handling the password is not something to automate.
  - **Still unverified until a real reboot: whether Ollama is happy under SYSTEM in session 0** (GPU
    acceleration is the thing to watch). If models get slow, leave Ollama in the Startup folder and keep
    only Latch + Bureau as tasks — Bureau degrades honestly when the model is gone (see `modelUnreachable`).
- **Remote access — WORKING as of 2026-07-31, one step left (a device, not code).** Verified end to end
  from this host: `tailscale serve` proxies `https://<your-host>.<your-tailnet>.ts.net:8443` → `127.0.0.1:4173`
  (and `:443` → Latch on 8787), TLS valid, the UI and `/api/whoami` both 200 with a token, **401 without
  one**, and Bureau stays bound to loopback only — the tailnet does the exposing, not a wider bind.
  - **`BUREAU_REMOTE` was the real gap, and it was invisible.** It lived in whatever shell started the
    process, so `node server.mjs` by hand served an **unguarded** control surface on a live public
    hostname. `Start-Bureau.ps1` now makes the guard the default, warns in red if `-Local` is used while
    tailscale is serving the port, and refuses to double-start. Confirmed `remote:true` over the tailnet.
  - **DONE — confirmed from the managed work laptop, 2026-07-31.** Tailscale installed there, opened
    `https://<your-host>.<your-tailnet>.ts.net:8443`, full UI rendering with live company data and `🔒 REMOTE MODE`
    visible in the header. The open question from July — "whether a managed work laptop's network
    cooperates" — is answered: it does, with no Cloudflare Tunnel needed. That fallback stays documented
    for a machine that forbids a mesh client, but is not required here.
  - **Two defects only a second machine could find, both fixed the same day.** Signed out, the UI rendered
    its first-run onboarding wizard over a live 12-agent company (a 401 body has no `ceo`, so "cannot read"
    and "brand new" were one condition) and the only route to the sign-in prompt was an accidental 401 —
    the badge was a `<span>` whose tooltip told you to reload. And the failed-auth damper keyed on
    `socket.remoteAddress`, so behind `tailscale serve` every client shared one bucket with localhost while
    any success wiped the counter. See SECURITY.md. _On the host you almost never load the page
    unauthenticated, which is exactly why all three survived until someone did._
  - **The e2e knows about both postures:** S4 asserts the seam REFUSES a hard-floor approval (403) when
    `BUREAU_REMOTE` is on, instead of failing because correct behaviour looked like a broken seam.

---

## Shipped

The core vision — *point Bureau at a goal and let it run itself, only surfacing finished, QA'd
work* — is built, and guarded by an automated suite (`node test/run-all.mjs --serve` —
**<!--fig:assertions-->1,793 headless assertions across <!--fig:suites-->21 suites** + a live `--e2e`; see
`test/README.md`). _Those two numbers are checked against a real run on every invocation of the runner
and fail it if they disagree — this line read "636 across 7" for a fortnight while the truth was more
than twice that, which is why it is now an instrument rather than a habit._

- **The review subsystem (2026-08-06 → 2026-08-15)** — a second phase whose exit condition is
  **exhaustion, not satisfaction.** The Definition-of-Done gate answers *did we build what was asked?*
  Nothing answered *what is wrong with it that nobody asked about?* — the motivating observation being
  that 4water was feature-complete at commit 35 while the 121 commits after it found real defects, none of
  them in any acceptance criterion. Runs after a run PASSES (`guardrails.investigate`, default on,
  `investigateRounds` to cap it, `investigate:false` per run), or on its own as **`mode: "hunt"`** — which
  a schedule can also ask for. The full narrative, including every experiment that failed and what it
  cost, is in [TESTING.md](TESTING.md); this is what exists.
  - **The probe gate — a finding is a claim PLUS an observed control, and the RUNNER does the observing.**
    An agent registers a finding with a `check` (from a narrow allowlist — `node --test`, `npm test`,
    `npm run <script>`; not `shell`, which is hard-floored) and a fix as an exact `{file,find,replace}`
    anchor. In a throwaway git worktree the runner observes: the check **fails** as things stand, **passes**
    with the fix, the project's **existing suite still passes**, and it **fails again** on revert. Anything
    else is REFUSED with the reason. A finding may also carry a **probe** — a test the agent writes, which
    the runner writes in, runs and throws away — because most real defects have no failing check already;
    if one did, somebody would know. `check` is *derived* from the probe, so a probe cannot be paired with
    a command that runs something else. Four refusals guard the rest, each with its own test: a probe that
    reads the source file and asserts on its **text** (the proxy problem in its purest form — fails, passes,
    fails again, while testing nothing about behaviour); a probe that passes regardless; a fix that
    satisfies the probe but breaks the existing suite; and a probe that would **overwrite** an existing
    test rather than add one, which would let an agent replace a check that disagreed with it. An ambiguous
    anchor cannot patch anything: `apply()` counts occurrences and requires exactly one.
  - **The lens register** — eight built-in ways of looking (`spec-descriptive`, `sibling-path`,
    `what-would-it-accept`, `collector-blind`, `walk-the-sequence`, `stale-claim`, `permissive-default`,
    `first-command`), each a standing instruction, selected **coverage-first** so an unused lens outranks a
    productive one. A round books `found` / `dry` / `rounds` against its lens, and an autonomous **critic**
    proposes new lenses citing the findings that motivated them, capped. `GET/POST/PATCH /api/lenses`, and
    a panel in the UI. _Exhaustion means dry **and** plateaued — a dry round that opened new files does not
    count against the limit, or a run stops at 13% coverage and calls it thorough._
  - **The question queue — an open question must not stop the work.** A second derivation runs alongside
    the criteria asking *what decisions does this objective not make?*, as its **own** model call: a
    malformed reply must cost a missed question, never a run with no criteria. The agent queues the
    question with `ask_stakeholder` and **carries on** — nothing waits, no approval is created. An
    assumption claiming approval, agreement or a decision is refused (*"assuming the CEO approved the
    2-year retention"* reached a deliverable as *"(assumed approved by CEO)"* once; the CEO approved
    nothing), while **owning** the choice still passes. `GET/POST/PATCH/DELETE /api/questions`.
  - **The declined-check register — an excuse is a claim.** The third gate: Bureau refuses an unproven
    *finding* and an unstated *assumption*, and the missing one was an unexamined **exemption**. It comes
    from a real failure here, caught by the operator: two panels and a dozen renderers shipped unlooked-at
    because *"the authed UI needs the operator token"* — false, since this repo's own test runner had
    always minted a disposable one. `declined_check` requires three fields and refuses without any of them:
    what was not checked, why, and **what would have to be true for it to become possible**. Then the
    runner tries to **falsify** it, translating noun phrases into identifier spellings and grepping the
    repository; it hands the counter-evidence back **once** and accepts a re-declaration, because a gate
    that overrules the conclusion gets routed around. `GET /api/declined-checks`, and a **Not checked**
    panel in the UI.
  - **The scope guardrail** — `guardrails.scopeFiles` mechanically restricts which paths `read_repo` may
    open, as a rule in the runner rather than a sentence in the prompt (the prompt said "you cannot write
    files"; the dispatcher blocked exactly two action types). A scope of **≤20 files** raises the read cap
    from 12,000 to 60,000 characters, so a bounded file set is read WHOLE — every false claim this
    subsystem produced came from an agent reasoning about a 4,000- or 12,000-character prefix as though it
    were the file.
  - **Reading a repository at all** — `read_repo` lists, reads and greps, all through Latch's boundary and
    Bureau's own guard. A truncated read carries a complete **outline** of every declaration with line
    numbers (bounded by symbol count, never by position) and marks each `seen`/`partial`/`unseen`, because
    *a truncated read is evidence of PRESENCE and never of ABSENCE* — a warning saying so was ignored twice,
    so the fix is structural. A round opens with a **whole-repo digest** (87 files in ~2,000 tokens for
    4water) whose index is always complete and whose per-file breakdown is what gives way under budget; a
    file bigger than one read is marked. Older read bodies **collapse to their outline** before the history
    is re-sent (57% off billed tokens), keeping the two most recent verbatim so anchors can still be
    quoted. A **file-coverage ledger** records what each round opened and orders the map by it.
  - **A refuter, scoped to the two questions no mechanical control can answer** — whether a check tests the
    property its claim names (`fail → pass → fail` cannot see a proxy), and whether a declined check's
    reason is sound when the falsifier finds nothing to contradict. It produces a **caveat, never a
    verdict**, is recorded *after* the finding so it cannot overturn an observation, and the stored text
    says it ran on the same model as the agent — a same-model refuter that could overrule an observation
    manufactures the appearance of independent confirmation.
  - **What it has and has not shown.** One confirmed finding on a repository deliberately made red; one on
    a **green** repository under a controlled arm with the lens forced. Zero across five unforced rounds on
    that same green repository, which is the open item in **Next**. Every mechanism is unit-tested; none of
    that is a substitute for the outcome.

- **Unattended operation (2026-07-31)** — the boot-at-startup work changed Bureau's category from
  *a thing you start* to *a service that runs whether or not anyone is watching*, which needs things a
  hand-started dev tool never did:
  - **Logs that exist.** A scheduled task captures no stdout, so a 3am crash-and-restart left no trace
    at all — `bureau.log` sat at 0 bytes while the server ran, because the boot task uses
    `Start-Bureau.ps1 -Foreground` and the redirect only existed on the detached branch. Both servers now
    tee stdout/stderr to a size-rotated file in-process (`BUREAU_LOG`/`LATCH_LOG`, 5 MB × 3), so the log
    exists however the process was started. Stamped per line, not per write. No `uncaughtException` or
    `unhandledRejection` handler on purpose — registering either downgrades Node's default crash-and-exit,
    and the traces already go through stderr, which the tee captures.
  - **Boot failures are recorded too.** The tasks redirect streams 2 and 6 (`2>>boot.log 6>>boot.log`) —
    PowerShell errors and the launcher's own `Write-Host` refusals, e.g. "Port 4173 is already served by
    pid …", which no in-process tee can see. Stream 1 deliberately not redirected: that is the servers'
    normal chatter, already captured with rotation.
  - **Verified daily backups** (`tools/backup.mjs`, `LLMServer-Backup` at 03:30). Bureau's WAL database via
    `VACUUM INTO` (a plain copy loses whatever is in `-wal`), Latch's 54 MB `db.json` gzipped to ~4 MB, and
    every small config JSON. **Every artifact is opened and parsed after being written** and a snapshot
    failing any check is renamed `*.FAILED` so it can never be mistaken for a good one. `--list` reports
    "newest verified", or `NONE — you have no proven backup`.
  - **A restore drill** (`tools/restore-drill.mjs`), because a backup nobody has read is a hope. It restores
    the newest snapshot and boots a **real Latch** on it, then asserts the restored instance serves the same
    counts as production. Proven 2026-07-31: 360/360 approvals, identical `/api/state`.
  - Snapshots live **outside both git repos** and the tool **refuses** to write into a git work tree or a
    cloud-synced folder — they contain the operator token and a billable API key.

- **Safe autonomy** — per-agent allowlists → autonomy tiers → declarative policy rules, all under
  one inviolable hard floor (shell / api_call / email / over-ceiling spend always require you).
  Plan-approval gate, Definition-of-Done gate, audit trail, spend caps, rate limits.
- **In-app approval seam** — decide pending actions inside Bureau (same Latch PATCH, deliberate confirm).
- **Getting work done** — hierarchical delegation; real actions (web fetch/search, file write,
  guarded `api_call`, `shell` on the VM, **GitHub file publish** via Latch); richer file types + export; keyword RAG memory.
- **Runs itself** — goals/OKRs with scheduled auto-advance, inbound triggers, notifications, and a
  self-optimizing loop (scorecards → HR recommendations → coaching lessons → goal retrospectives).
- **Internal Plan / backlog** — a persistent per-workspace to-do list the agents maintain: they see
  the open plan at the start of every run, record follow-up work they discover with a `plan_add`
  action (so nothing is lost between runs), and you inspect / reprioritize / assign / "work on" items
  in Bureau. Runs link back and auto-advance an item's status. This — not Slack — is how an agent org coordinates.
- **Deliverable lifecycle** — draft → QA'd → your sign-off → delivered, with versioning.
- **Dry-run mode**, **run history & replay**, **company templates**.
- **Multi-workspace** — each workspace is a fully isolated company.
- **SQLite datastore** — org data + a normalized, uncapped audit log live in `data-bureau.db` (Node's
  built-in `node:sqlite`, WAL mode) instead of per-workspace JSON files. Atomic writes (no
  half-written corruption) and real locking (no cross-process clobber). Boot migrates existing JSON in
  automatically; the JSON is left in place as a rollback fallback. Mutator API unchanged; all tests pass.
- **Paid-model routing** — funded agents route to a paid provider (Moonshot/Kimi) with per-agent
  model tiers (Standard K2.6 / Coder K2.7 / Heavy K3); cost booked against the model that served the
  call, capped by each agent's `budgetUsd`. Unfunded agents stay on the free local model. _Verified working._
- **Paid reliability for JSON-critical calls** — decompose / deriveCriteria / verifyRun route to the
  cheapest paid tier when the run's principal is funded (the weak local model is worst exactly at
  strict JSON). Off for hush runs; falls back to local when unfunded/unavailable.
- **Eval / regression harness** (`eval/run-eval.mjs`) — offline, no-side-effects harness that replays
  golden cases through the three JSON-critical calls against local qwen3 and (opt-in) paid Kimi, and
  reports single-shot / effective / schema-valid / fan-out / verdict rates + latency + cost. Committed
  `baseline.json` + a `--baseline` regression gate. Turns "qwen3 is flaky at JSON" into a measured,
  gateable number.
- **Parallel execution (Stage 1)** — opt-in concurrent sibling delegation (see **Next** for what's
  outstanding).
- **Mid-run human steering** — pause / resume a live run and inject CEO course-corrections that active
  agents fold into their next turn (`POST /api/run/:id/steer`; run-control bar in the UI, which also
  finally wires up the pre-existing `/stop` endpoint). Broadcast to every active agent via a per-agent
  cursor over an append-only steer list — works for single, company, and parallel runs. _Live-verified
  2026-07-23: paused a run, injected a steer, resumed — the agent changed course to the new instruction
  on its next turn. Future refinement: per-agent targeting (v1 broadcasts run-wide)._
- **Agent-to-agent comms** — the `ask_peer` action lets an agent consult a named teammate mid-task
  and fold their reply back into its own reasoning. Because agents have no standing loop, it's a
  synchronous, advisory-only consult (persona-only prompt, one local call — the peer can't take real
  actions or recurse), run through the FULL gate: allowlist → action cap → policy (`who may talk to
  whom` as audited rules) → tier/approval → Latch card → audit row. Not an unaudited side channel.
  _Live-verified 2026-07-23: Jordan (PM) consulted Morgan (CISO), who replied in character, and Jordan
  used the input to finalize. Future: executable hand-off (peer does real work), not just advice._
- **SOP / process templates** — a named, reusable, ordered step-list (`org.sops`) the company runs
  step-by-step, each step by a named teammate, in sequence with handoff. Running an SOP **bypasses the
  LLM decompose entirely** — the determinism payoff, since decompose is the flakiest call on local
  qwen3. Unresolved assignees fall back loudly (never silently dropped); the DoD gate still applies.
  CRUD + a "Processes" UI section with a per-step editor. _Live-verified 2026-07-23: a 3-step SOP ran
  Zoe → Morgan → Jordan in exact order, decompose skipped (zero fallback events), DoD passed. Future:
  per-step acceptance criteria; scheduling an SOP._
- **Shared company memory** — every agent now recalls the most RELEVANT prior work from ACROSS the
  team (not just its own last 5 by recency), injected into its prompt so knowledge compounds org-wide.
  Relevance is a pure-JS BM25 ranker (`rankByRelevance`) over the pooled memory corpus — no deps, no
  embedding infra; a vector store can later slot in behind the same interface (see **Next**). Exposed
  at `GET /api/memory?q=`. _Live-verified 2026-07-23: cross-agent recall returned ranked, relevant
  entries; unrelated memories excluded. Units 133 → 147._
- **MCP server (expose)** — Bureau speaks the Model Context Protocol at `POST /mcp` (JSON-RPC 2.0, no
  deps), so external MCP clients (Claude Desktop, other agents) can drive the company: `list_agents`,
  `list_sops`, `run_sop`, `start_run`, `search_memory`, `list_deliverables`, `read_deliverable`.
  Localhost-only, same trust boundary as the rest of the API — no new surface. _Live-verified
  2026-07-23: initialize handshake, tools/list (7), tools/call list_agents/search_memory, error codes._
- **MCP tools (consume)** — the `mcp_call` action lets an agent invoke an EXTERNAL MCP tool, brokered
  entirely through Latch: Bureau files a `mcp_tool_call` approval, Latch runs the tool on the trusted
  host with the server's own credentials (Bureau sees none) and returns the result, which the agent
  gets as UNTRUSTED data. Hard-floored so Bureau never auto-approves it — the decision is Latch's
  (per-tool allowlist + fingerprint/rug-pull guard), else a human in Compass. Bureau opens no outbound
  MCP sockets. Discovery via Latch's `/api/mcp/servers`; dormant when MCP is unconfigured. _Verified:
  hard-floor unit tests, graceful-when-off. Full E2E needs an MCP server in Latch's `data/mcp.json`
  (operator setup)._
- **Remote-access hardening** (2026-07-25, `0186733`) — groundwork for reaching Bureau from another
  machine. The insight driving it: the operator token can approve hard-floor approvals, so holding it is
  equivalent to shell access on the host — the hard floor stops a rogue agent, never a human with the
  token. So: **tokens are header-only** (`?token=` no longer authenticates anywhere, including the SSE
  stream — a token in a URL lands in every proxy/tunnel access log), the UI reads the run stream with
  `fetch()` + a stream reader instead of `EventSource`, a **failed-auth damper** returns 429 past 10
  failures per address per 10 minutes and records each burst in the audit log, and **`GET /api/whoami`**
  lets the UI badge itself `👁 read-only` and explain refusals — making the read-only token a practical
  everyday mode for a less-trusted browser. _Live-verified 2026-07-25 against the real server in
  throwaway workspaces: query tokens dead, roles correct, damper trips/clears, and the new stream reader
  consumed a real 10-event run across 6 network chunks with zero unparseable frames. Also fixed
  `test/e2e-autonomy.mjs`, unauthenticated since the auth gate landed._
- **Remote mode `BUREAU_REMOTE=1`** (2026-07-30) — closes the last remote-access gap: Bureau's in-app
  approval seam will still **deny** anything but only **approves** an allowlist (`SAFE_TIER_ACTIONS`
  plus an under-ceiling purchase), so a browser holding the operator token can't turn state-reading into
  shell execution. Deliberately an allowlist rather than a hard-floor lookup — "is it hard-floored?"
  answers "no" for anything unrecognised, so unknown action types default to *safe* instead of
  approvable — and it fails closed on any approval whose origin can't be established. Provenance comes
  from an `act-<type>` tag stamped at filing time, because Latch's own `type` is too coarse
  (`web_search`, `shell`, `api_call` all arrive as `"command"`). _Live-verified against real Latch._
  **Found and fixed alongside it:** Latch strips colons from `contextTags`, so `ws:default` was stored
  as `wsdefault` — the Inbox's per-workspace filter had never matched (default workspace saw every
  workspace's approvals; others saw none), and agent attribution was silently blank. All Bureau tags now
  go through `mkTag`/`readTag` with a hyphen separator. _Isolation verified live._
- **Semantic memory — vectors fused with BM25** (2026-07-30) — the "semantic" half of shared memory.
  Vectors live in a SQLite `embeddings` table keyed by (workspace, kind, item) and scoped to the
  embedding model, so switching models can never mix two incompatible vector spaces; a `text_hash`
  triggers re-embedding when an entry changes. Ranking uses **Reciprocal Rank Fusion** over the vector
  and BM25 rankings rather than blending scores — BM25 scores and cosine similarities have no principled
  common scale, and RRF needs none, which also means a partly-embedded corpus degrades smoothly instead
  of skewing. Embedding happens fire-and-forget after each run, so no run waits on it, plus
  `GET /api/embeddings` and `POST /api/embeddings/backfill`. Every failure path — no embedder, no model,
  timeout, missing vector, dimension mismatch — falls back to exactly the previous BM25 behaviour.
  Bureau calls the local embedder **directly** rather than through Latch: it's keyless and local, so
  there's no credential to protect (documented in `SECURITY.md`). _Unit-tested end to end (209 unit
  assertions). **Live-verified 2026-07-30** after `ollama pull nomic-embed-text`: all 45 memory entries
  embedded in 16.3s at 768 dims with zero failures, and on 6 paraphrase queries chosen in advance to
  share no significant keyword with their target, hybrid recall gained results over BM25 every time —
  including two where BM25 returned nothing at all ("why lists help you not forget steps" → the
  checklist work; "picking what matters most next quarter" → the Q3 priority work, with no shared term
  since the corpus says "Q3"). One query surfaced no correct match in either mode; see **Next**._
- **GitHub issues, both directions** (2026-07-31) — agents can work a real backlog instead of only pushing
  files outward: `read_issues` pulls the repo's open issues (the external twin of the internal Plan),
  `github_issue` opens one, `github_comment` replies on one. The token stays in Latch, which gained a
  `GET /api/github/issues` read plus `github_issue` / `github_issue_comment` approval types and executors.
  **Posting is hard-floored, committing a file is not**, and the asymmetry is the design: a commit is
  content — silent and undoable via git history — while an issue emails every watcher the instant it posts
  and nothing recalls that, which is why `email_draft` is floored too. Bureau and Latch enforce it
  independently. Issue text is **untrusted third-party input**, framed for the model the same way
  `mcp_call` results are, and the real containment is that every action an injected instruction could ask
  for is itself gated. _Verified end to end, 32 checks across two scripts: the Latch side (auth, validation,
  both approval types pending rather than auto-approved, sanitisation, label caps, zero leaked approvals)
  and the real round-trip against `bureauProjects/sandbox` — an issue appears with title/body/labels/author,
  a DENIED create approval posts nothing, a comment posts and the count rises, and a bad issue number fails
  with `No issue #999999` and returns to pending so it is retryable. `GET /api/github/doctor` was added
  along the way because `/api/github/config` reported `ready: true` while every issue call 403'd — `ready`
  only ever meant "a URL and token are present"._
- **GitHub pull requests** (2026-07-31) — `github_pr` opens a PR containing the deliverables the run already
  saved. **One approval creates the branch, commits onto it, and opens the PR**, which makes it the widest
  single action Bureau has and is why it is hard-floored. Atomic is the *safer* shape: split across three
  approvals it would be three human decisions for one reviewable unit, and declining the second would
  strand a half-built branch. The files travel **inside** the approval, so what the operator reads is what
  gets committed — no second fetch between decision and write. The agent never assembles a file list (this
  model is worst at nested JSON): it writes with `file_write` as usual and the PR is built from
  `run.producedFiles`, read back off disk. A `github_pr` with nothing saved is refused **before** an
  approval is filed, with a message saying to save the work first — an empty PR should never reach the
  inbox. **Branching model: one branch per PR, `bureau/<slug>`, and nothing deletes them** — that is
  GitHub's "Automatically delete head branches" repo setting, the right owner for the decision. _Verified
  live, 13 checks: a denied approval produces no branch and no PR; an approved one reports number, URL and
  branch→base; the PR is filtered out of `read_issues`; an empty PR refuses and stays retryable._
- **The failure paths, made loud** (2026-07-31) — an audit of every place Bureau stayed quiet when
  something went wrong. Each of these was one line of `catch {}` or one missing sibling call, and none
  of them broke a test, because nothing was watching.
  - **A run that fails now leaves a record** (`a35c151`). Measured: `POST /api/run` answered 201 with a
    runId and left **zero** durable trace — `/api/runs` empty, `/api/audit` empty, `budget.runs` still 0.
    Two one-call repros (company run with an empty roster; single run naming a deleted agent) did
    `emit(error); finishRun()` and skipped `persistRun` entirely. Worst on the unattended paths: a
    schedule whose agent was deleted no-op'd on every fire, forever, and the audit log agreed nothing
    happened. All abnormal exits now go through one `failRun()` — audit row with `verdict:"error"` **and
    the reason**, consumption booked (paid dollars leave the account the moment Latch serves a turn, so
    dropping them would silently restore an agent's budget), run listed. The crash handler moved *inside*
    `wsStore.run` — hung outside it, the bookkeeping would have filed every workspace's failures under
    `default`. `/stop` on an unknown run 404s instead of confirming `ok:true`.
  - **Notifications report their own failures** (`0ce29fb`). The one feature whose whole job is to reach
    an absent operator was fire-and-forget over a response nobody read. Measured: a closed port was
    completely silent (0 audit rows, `/api/notify` still showing the URL as healthy) and **HTTP 500
    counted as success**; a *failed* run pushed nothing at all. Now `res.ok` is checked, failures are
    warned and audited as `kind:"notify"` (a healthy webhook stays quiet — only failures and recoveries
    are logged), `lastDelivery` is readable, `run_failed` fires, and **`POST /api/notify/test`** plus a
    Test button let an operator confirm a URL instead of saving it and hoping.
  - **An unreachable model is a failure, not a finished run** (`1cda7a5`). With the model down and zero
    tokens spent, a run reported verdict `none`, wrote an audited `file_write` with `ok=true`, and left a
    draft in the inbox reading _"The team completed the assigned tasks."_ — a sentence **Bureau** wrote,
    from a `catch` in the manager's synthesis fallback. That is precisely the fabrication the turn loop
    guards against in a comment a few hundred lines above. Fallback text now says the summary is missing
    rather than claiming success; `modelUnreachable(run)` (true only when calls were attempted and *every*
    one failed) fails the run with the cause; and the delegation safety net will not invent a deliverable
    out of Bureau's own placeholders. _Verified with a second Bureau on a dead `LATCH_URL` **and** a
    control run against the real model — a guard that condemns working runs would be worse than the bug._
- **Version archives: no orphans, nothing unreachable** (2026-07-31, `77112a0`) — measured the real
  corpus: **116 archive files on disk, 10 listed by any endpoint.** The DoD checklist is rewritten after
  every verify pass and is deliberately kept out of `org.deliverables`, so each rewrite archived a file
  with no org entry to list it from and nothing ever pruned `.versions/` — orphans from birth, one per
  pass, forever (one objective had 19). Checklists are no longer archived; the 20-version cap now applies
  to **disk** as well as metadata (`trimVersions`, unit-tested as a partition because the off-by-one
  either leaks files or deletes an archive still listed); and the versions list reads the **directory**,
  which made all 116 reachable again and means a deleted document's archive is discoverable without
  having kept `archivedAs`. A failed archive write no longer loses the prior content silently.
- **Memory de-duplicated at write time** (2026-07-31, `0066206`) — `agent.memory` keeps 8 per agent and
  `persistRun` blind-prepended, so repeats of one objective evicted distinct history: measured, **all
  eight** of one agent's slots held e2e test objectives and three weeks of real work was gone. Recall-time
  de-duplication existed for exactly this symptom but collapses duplicates in the *ranking* — it cannot
  recover what the cap already discarded. Same preference logic now runs before truncating, so the cap
  holds 8 *distinct* objectives (and a later summary-less re-run can't displace the attempt that worked).
- **Deliverable deletion, archiving rather than destroying** (2026-07-31) — closed a gap that had always
  been there: a document could be written, versioned, QA'd, signed off and delivered but never removed.
  `DELETE /api/deliverables/:name` moves the file into the existing `.versions` store as `name.<ts>` (the
  same shape a normal overwrite leaves), so a mistake is recoverable and the content stays readable via
  `GET /api/deliverables/:name/versions/:ts`. **It also drops the document's embedding rows** — without
  that a deleted document keeps its vectors and goes on being recalled into agent prompts as "relevant
  existing company work", citing a file that no longer exists. Operator-only via the existing auth gate,
  and audited with the archive filename. The org entry is dropped rather than tombstoned on purpose:
  `deleted` is not one of the four real statuses, and a fake one would leak into every dashboard that
  walks `org.deliverables`. _Live-verified: archive byte-identical and readable back, retrieval stops
  citing it, neighbouring documents untouched, no orphaned pending vectors, one audit row, second delete
  404s. Traversal collapses to a basename inside drafts/ and leaves files outside it alone._
  **UI:** a `🗑 Remove` control in the document's detail view — not the list, so you have to open a
  document and look at it first — hidden outright for a read-only token rather than shown then refused.
  The confirm text deliberately does **not** say "cannot be undone", because it can be: it explains that
  the content is archived into version history and the removal is in the audit log. Overstating danger
  teaches people to distrust the wording.
- **Per-passage chunking for long deliverables** (2026-07-30) — one vector per document only represents
  its *opening*, since `nomic-embed-text` stops near 2048 tokens, so a fact buried later in a long
  document was invisible to retrieval however well it matched. Documents are now split into ~1200-char
  passages (heading boundaries first, then paragraph breaks, slicing mid-paragraph with overlap only when
  a paragraph is itself oversized), each carrying the document title for context, each with its own
  vector keyed `filename#idx`. A document scores as its **best** passage, so a long document isn't
  penalised for its irrelevant parts — and the prompt excerpt is now the passage that actually matched
  rather than always the opening. Embedding is per document (all passages or none), so a partially
  embedded document can't be mistaken for a fresh one; the pre-chunking rows migrate automatically.
  **Honest scope: zero measurable gain on the current corpus, whose largest document is 1489 bytes
  against the old 4000-char cap.** This is forward-looking. _Verified on a synthetic 12,165-char runbook
  with a distinctive fact at char 9296 — past where the old path could ever see: retrieved correctly by
  paraphrase, excerpt contained the buried passage, and passage-vs-opening similarity was 0.677 vs 0.427.
  Re-verified no regression on the real corpus (still 12/14), and the eval now embeds per passage so it
  measures what actually ships._ Also adds `GET /api/rag?q=` — deliverable retrieval was the one
  retrieval path with no inspection endpoint, which is part of how it sat at 21% unnoticed.
- **Deliverable retrieval, semantic + BM25** (2026-07-30) — the "relevant existing company deliverables"
  block in every agent prompt was the weakest retrieval path in Bureau, and nobody had measured it. It
  used a term counter that required **2+ distinct query terms to match at all**, so any paraphrase
  returned nothing. Measured recall@3 over 14 labelled queries (`node eval/recall-eval.mjs`): retired
  term-counter **3/14**, BM25 6/14, semantic alone 12/14, **BM25+semantic fused 12/14**. Now ranked with
  the same RRF fusion memory uses — a **4× improvement**, and the biggest single retrieval win so far.
  Three variants tied at 12/14; the tie was broken on the **failure mode**, not the headline: fused still
  returns BM25's 6/14 when no embedder is present, where semantic-alone would return nothing. Deliverables
  are embedded as humanised-filename + opening content (the filename carries real signal), keyed by
  filename with a content hash so an edited document re-embeds. The retired ranker lives on inside the
  eval as the historical baseline rather than as dead code in the server.
- **Recall de-duplication** (2026-07-30) — re-running a task, or a QA remediation pass, appends another
  memory entry whose first line is identical and whose tail differs only in appended criteria/verifier
  text. A `limit=3` recall could therefore return the same knowledge three times. Recall now collapses
  repeats before applying the limit, keyed on the **first line** of the objective (everything after a
  blank line is appended context, not the task). Two judgement calls, both driven by real data rather
  than assumption: the surviving copy is the one that **has a summary** — not simply the newest, because
  the corpus had a stopped, summary-less re-run sitting above the attempt that actually produced the work
  — and collapsing is **per agent**, since two different people doing the same task is a real signal
  worth a slot while one person doing it three times is not. Applies to the agent's own-work block too,
  and helps BM25 exactly as much as vector recall: this bug predated embeddings. _Verified on the real
  corpus: "why lists help you not forget steps" went from the same entry ×3 to three distinct entries._

---

## Parked / in flight

- **Paused background sessions** (delegation-breadth fan-out; paid per-agent model routing) — their
  partial work is already merged; the sessions themselves should not be resumed.
