# Bureau — Roadmap

Bureau is a management-sim orchestrator: hire a company of AI agents, point them at goals, and
they take **real, approval-gated actions** through the Latch backend. Latch is the security
boundary; Bureau is the control surface.

_Forward-looking only — the detail of what's shipped lives in the code, the tests, and git history._

---

## Next

**In flight — Parallel execution.** Stage 1 shipped (2026-07-23, commit `6dbe3a9`): opt-in
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
  - **Stage 2 — dependency-aware decompose** — the case for it is now *weaker*, not stronger: if blanket
    concurrency yields 0.92x locally, ordering it more cleverly cannot help locally either. Stage 2 only
    pays off where the underlying calls actually overlap, i.e. the paid tier. Still gated on measuring
    whether a `dependsOn` field regresses decompose reliability (already the flakiest JSON call).
  - **Paid tier measured 2026-07-31 (`--paid`, one pair, $0.25) — parallel looks like a real ~2.4x win
    there, but the single pair is CONTAMINATED and wants repeating.**
    - sequential 1165.9s vs parallel 494.2s, same 4 sub-tasks both, concurrency confirmed (1 vs 3
      dispatched within a second) → **2.36x**, against 0.92x locally. Directionally exactly what theory
      predicts: external calls don't share one process, so overlapping them actually overlaps.
    - **First useful fact: a paid sub-task takes ~300s against ~30s locally (~10x).** That, not the
      concurrency, is why the local measurement found nothing to win.
    - **The confound:** the parallel run hit `"The engine is currently overloaded, please try again
      later"` from Moonshot. A failed paid call can fall back to the ~10x faster local model, which would
      flatter the parallel side. So 2.36x is an upper bound, not a measurement.
    - **Second useful fact, operational:** firing 3 concurrent Kimi requests is enough to trip a provider
      overload. Anyone turning on parallel + paid should expect that, and `ORCH_MAX_PARALLEL` is the dial.
    - **Cost model correction:** billed paid tokens ran ~1.75x the run's own token figure (68,674 vs
      39,199), because each turn resends the growing history. Budget ~$0.14/run, not the ~$0.07 a naive
      token count suggests.
    - To settle it: 3 more pairs (~$0.75, ~90 min) and discard any pair that logs a provider error.

**The eval gate is currently RED, and deliberately left that way.** `node eval/run-eval.mjs --baseline`
(8 reps, 2026-07-31) reports `criteria.singleShotRate: 100% → 78%`, past the 15% tolerance. Decompose
(50%/75%) and verify (100%) match the baseline exactly.
  - **Not user-visible.** Criteria's *effective* rate is still 100% — the retry ladder absorbs every
    first-shot miss. The cost is latency and tokens (p95 18.8s), not failed runs.
  - **Bureau's code is not the cause, on evidence.** The last change to the criteria prompt (`67f7e6e`)
    landed at 09:18Z, *before* the 10:40Z baseline, and `git log -S` finds no commit after the baseline
    touching `buildCriteriaMsgs`, `validateCriteria` or `deriveCriteria`. The eval cases and harness are
    unchanged too. Same code, different score.
  - **The model server changed underneath it.** In July, port 11434 answered with llama.cpp's
    "Start it with --embeddings"; today it is genuinely Ollama 0.32.1. So the baseline is not
    apples-to-apples, and a swapped inference backend is the most likely explanation.
  - **Re-baselining is left to the operator on purpose.** Running `--save-baseline` would turn the gate
    green in one command and erase the only signal that anything moved. If the new backend is the intended
    one, re-baseline deliberately and say so in the commit — don't let a red gate get quietly normalised.

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
- **Outbound integrations** — ◐ partial. **GitHub publish is done** (`github_file` / `github_repo`
  actions → Latch's native GitHub connector; Latch holds the token and commits on approval, Bureau
  stores nothing) with a **per-workspace target repo/owner** (setup: `GITHUB.md`). Still open only:
  GitHub **issues/PRs** (no Latch connector yet). **Slack was dropped on purpose** — agents coordinate
  through the internal Plan (shared state), not a chat channel; for *human* digests, point the existing
  notify-webhook at a Slack incoming webhook yourself.
- **Office-view revamp** — the isometric office is functional (renders from `public/assets/iso/`),
  but its visual design was parked. Pure presentation, no behavior change.
_(Deliverable delete is complete — API and UI both shipped, see below.)_
- **Remote access, last mile** — code complete (see Shipped). What remains is operator setup only:
  Bureau is already served on the tailnet at `:8443` alongside Compass; a Cloudflare Tunnel + Access
  hostname is the alternative for machines that can't run a mesh client. Untested piece: whether a
  managed work laptop's network cooperates.

---

## Shipped

The core vision — *point Bureau at a goal and let it run itself, only surfacing finished, QA'd
work* — is built, and guarded by an automated suite (`node test/run-all.mjs` — 292 headless
assertions + a live `--e2e`; see `test/README.md`).

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
- **Remote-access hardening** (2026-07-25, `1fab9db`) — groundwork for reaching Bureau from another
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
