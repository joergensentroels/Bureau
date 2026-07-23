# Bureau — Roadmap

Bureau is a management-sim orchestrator: hire a company of AI agents, point them at goals, and
they take **real, approval-gated actions** through the Latch backend. Latch is the security
boundary; Bureau is the control surface.

_Forward-looking only — the detail of what's shipped lives in the code, the tests, and git history._

---

## Next

Nothing is in active development. The remaining backlog, roughly by value:

- **Outbound integrations** — ◐ partial. **GitHub publish is done** (`github_file` / `github_repo`
  actions → Latch's native GitHub connector; Latch holds the token and commits on approval, Bureau
  stores nothing) with a **per-workspace target repo/owner** (setup: `GITHUB.md`). Still open only:
  GitHub **issues/PRs** (no Latch connector yet). **Slack was dropped on purpose** — agents coordinate
  through the internal Plan (shared state), not a chat channel; for *human* digests, point the existing
  notify-webhook at a Slack incoming webhook yourself.
- **Office-view revamp** — the isometric office is functional (renders from `public/assets/iso/`),
  but its visual design was parked. Pure presentation, no behavior change.

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

---

## Parked / in flight

- **Paused background sessions** (delegation-breadth fan-out; paid per-agent model routing) — their
  partial work is already merged; the sessions themselves should not be resumed.
