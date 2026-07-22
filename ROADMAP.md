# Bureau — Roadmap

Bureau is a management-sim orchestrator: you hire a company of AI agents into an org, point
them at work, and they take **real, approval-gated actions** through the Latch backend. This is
the working roadmap — Phase 1 is committed; everything below it is the backlog, in rough priority.

_Last updated 2026-07-22._

---

## Phase 3 — Next (planned)

Make the company smarter, connected, and shareable.

1. **Self-optimizing org** ✅
   - Per-agent **scorecards** from existing data (audit + memory + cost): runs, DoD pass-rate, deliverables, actions/ok, guardrail blocks, token/$ cost. `GET /api/performance` + a "📈 Reviews" modal.
   - **HR recommendations** (heuristic): idle / often-blocked / strong / low-pass-rate / reliable-producer.
   - **Learn from your feedback**: per-agent `lessons` injected into prompts; revision feedback auto-captured as a coaching note; editable in the agent modal.
   - ✅ **Goal retrospectives**: closing a goal generates a "what worked / what to change" note (async LLM), shown on the goal card, audited, and injected into future runs' context.
2. **Real integrations** ◐
   - ⬜ Push work OUT: GitHub (PRs/issues), Slack (updates), Drive/Notion — built on `api_call`/webhook + credentials (needs your tokens; do together).
   - ✅ **Inbound triggers**: a secret webhook URL per trigger; an external POST fires a preset run (autoApprove, but shell/api_call/over-ceiling purchases still gated), payload passed in as context. Managed in a "Triggers" section.
3. **Product-ization** ◐
   - ✅ **Company templates**: one-click preset teams ("SaaS startup", "content studio", "research lab") with roles + a starter goal, added non-destructively (reuses hire-plan + goals).
   - ⬜ **Persistence beyond JSON**: a real datastore (the single JSON + mutex is already straining under multi-process use). Deferred — most structural change; do carefully when the paused sessions are done.

_Parked but available:_ **paid-model activation / smart routing** — the biggest lever on output quality (local qwen3:8b is the ceiling); starts whenever a paid provider/API key is configured in Latch. Also still in the backlog: dry-run mode, in-app approval seam, declarative policy rules, run-history/replay UI, multi-workspace, office-view revamp.

---

## Phase 2 — Complete ✅

Raise what Bureau produces and how it reaches you.

1. **Fix delegation breadth** ✅ — Manager fans work out to several agents (dependency-ordered); plain-text fallback decomposition prevents single-task collapse when the model's JSON fails.
2. **Broaden real actions** ✅ — `api_call` (guarded outbound HTTP) + `shell` (VM command via the worker), both approval-gated and NEVER auto-approved. (email stays as the existing approval-gated `email_draft`.)
3. **Richer outputs + RAG memory** ✅ — richer file types (csv/json/code/etc.) + HTML/print export; keyword RAG injects relevant past deliverables into agent context so work compounds.
4. **Real notifications** ✅ — browser desktop alerts when a decision is waiting (on the inbox poll, permission-gated) + an optional outgoing webhook fired on run-done / needs-approval (wire to Slack/email yourself).

---

## Phase 1 — Complete ✅

Picked together. Theme: **point Bureau at a goal and safely let it run.** Suggested build order
below (foundations first).

### 1. Guardrails + audit trail  ✅ _done — commits 56e597b, 944b38c, 1f4a889_
Make autonomy safe, so we can let agents do more without babysitting.
- Per-agent **action allowlist** (which action types an agent may even propose).
- **Spend caps** (per-agent paid budget hard stop; company-funds cap) and an **approval threshold**
  ("auto-approve under $X / require me above it").
- Basic **rate limits** (max runs/actions per window) as a runaway backstop.
- **Audit trail**: an append-only provenance log — every action, its source/result, token & $ cost,
  and who approved it (you / auto / Latch). Surfaced as a filterable history view + run replay.

### 2. Plan-approval gate  ✅ _done_
The upfront cousin of the Definition-of-Done gate.
- Before a company run fans out, the manager's **plan is shown to you** (tasks + assignees + the
  derived acceptance criteria).
- You can **approve, edit, or reject** it; work only starts on approval (auto-approve remains an
  option for unattended/scheduled runs).
- Rejected/edited plans feed back into the decomposition. Kills wasted and off-track runs.

### 3. Deliverable lifecycle  ✅ _done_
- Explicit states: **draft → QA'd (DoD passed) → your sign-off → delivered**.
- **Versioning + diffs** on revisions (the revise loop already exists; keep history).
- A clear "awaiting your sign-off" queue in the Inbox.

### 4. Company goals / OKRs  ✅ _done_
- ✅ Persistent **goals/objectives** (OKR-style: title + detail + key results) that live above runs.
- ✅ **"Work on it"** launches a company run toward a goal; the run + its DoD verdict link back.
- ✅ Progress rolls up: key-result checklist + % bar + recent-run verdicts + a dashboard card.
- ✅ **Scheduled auto-advance** — a goal cadence (off/daily/weekly) auto-creates a goalId-linked
  schedule; the scheduler regenerates the objective from the live goal each fire and links runs back.

---

## In flight (paused background sessions)

- **Delegation breadth** — real parallel fan-out + dependency ordering (currently collapses to a
  single task on the local model). _[background task]_
- **Activate paid per-agent models** — per-task model routing so funded agents use a paid provider;
  track `paidSpentUsd`. _[background task]_

---

## Backlog (later phases)

### Make the work real & good
- Broaden **real actions**: shell/code execution on the VM, send-email-via-approval, structured API calls.

### Oversight & trust
- **Real notifications** — the Inbox pushes to you (desktop/email) instead of you polling.

### The company that runs itself
- **Performance reviews** — per-agent throughput, DoD pass-rate, cost → HR suggests promote / reassign / let-go.
- **Autonomy tiers** — traits set how much an agent can do without asking; daily standup/digest.

### Deliverables
- **Richer types & export** — code files, spreadsheets, PDF / shareable links.
- **Knowledge base (RAG)** — agents read past deliverables so work compounds.

### Platform & polish
- **Company templates** — spin up a preset org ("SaaS startup", "content studio") in one click.
- **Persistence & history** — move past the single JSON file as it grows; cost/output trends over time.
- **Office view revamp** — top-down/pixel redesign (parked).

---

## Parked (deferred, not dropped)

- **Folder + internal data-file rename** (`…/foreman` → `…/bureau`, `data-foreman.json`) — waiting
  until the paused background sessions are fully done, so their resume isn't broken.
