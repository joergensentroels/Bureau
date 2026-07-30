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
deliverable produced. A clean wall-clock speedup number is NOT yet established — local qwen3's
non-deterministic decompose gives the two runs unequal work, so a single A/B can't isolate the
concurrency gain (measured 4.6x, but confounded). **Outstanding:**
  - **Clean speedup measurement** — needs repeated runs or the more-deterministic paid tier to control
    for decompose variance.
  - **Stage 2 — dependency-aware decompose** — let the manager emit `dependsOn` per task and run
    independent tasks concurrently / dependent ones in topological levels. Gated on data: measure with
    the eval harness whether adding the field regresses decompose reliability (already the flakiest
    JSON call) before committing to it.

The remaining backlog, roughly by value (competitive-gap analysis, 2026-07-22):

- **Semantic memory — follow-up from the live A/B.** (Duplicate collapsing: **fixed**, see Shipped.)
  - **Neither ranker is reliable on ops-flavoured paraphrases.** "keeping servers healthy under heavy
    traffic" failed to surface the obvious match (Ava's monitoring / auto-scaling / load-testing entry)
    in either mode — BM25 matched the stopword-ish "under", and the vector ranking preferred unrelated
    entries. Worth investigating whether embedding `objective + summary` alone is too thin, since the
    QA-criteria boilerplate in many entries likely dominates the vector.
  - Still open: extend embedding from memory entries to **deliverables**. The table is already keyed by
    `kind`, so that's a new kind plus a backfill, not a redesign.
- **Outbound integrations** — ◐ partial. **GitHub publish is done** (`github_file` / `github_repo`
  actions → Latch's native GitHub connector; Latch holds the token and commits on approval, Bureau
  stores nothing) with a **per-workspace target repo/owner** (setup: `GITHUB.md`). Still open only:
  GitHub **issues/PRs** (no Latch connector yet). **Slack was dropped on purpose** — agents coordinate
  through the internal Plan (shared state), not a chat channel; for *human* digests, point the existing
  notify-webhook at a Slack incoming webhook yourself.
- **Office-view revamp** — the isometric office is functional (renders from `public/assets/iso/`),
  but its visual design was parked. Pure presentation, no behavior change.
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
