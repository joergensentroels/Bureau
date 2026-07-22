# Bureau — Roadmap

Bureau is a management-sim orchestrator: hire a company of AI agents, point them at goals, and
they take **real, approval-gated actions** through the Latch backend. Latch is the security
boundary; Bureau is the control surface.

_Forward-looking only — the detail of what's shipped lives in the code, the tests, and git history._

---

## Next

Nothing is in active development. The remaining backlog, roughly by value:

- **Paid-model activation / smart routing** — the biggest lever on output quality (the local
  qwen3:8b model is the ceiling). Per-task routing so funded agents use a paid provider; track
  `paidSpentUsd`. _Blocked on: a paid provider / API key configured in Latch._
- **Outbound integrations** — push work OUT to GitHub (PRs/issues), Slack, Drive/Notion, built on
  the existing `api_call` / webhook plumbing. _Blocked on: your credentials / tokens._
- **Persistence beyond JSON** — move off the single JSON-file-per-workspace + mutex to a real
  datastore. The most structural change; do it carefully. More relevant now that multi-workspace exists.
- **Office-view revamp** — the isometric office is functional (renders from `public/assets/iso/`),
  but its visual design was parked. Pure presentation, no behavior change.

---

## Shipped

The core vision — *point Bureau at a goal and let it run itself, only surfacing finished, QA'd
work* — is built, and guarded by an automated suite (`node test/run-all.mjs` — 262 headless
assertions + a live `--e2e`; see `test/README.md`).

- **Safe autonomy** — per-agent allowlists → autonomy tiers → declarative policy rules, all under
  one inviolable hard floor (shell / api_call / email / over-ceiling spend always require you).
  Plan-approval gate, Definition-of-Done gate, audit trail, spend caps, rate limits.
- **In-app approval seam** — decide pending actions inside Bureau (same Latch PATCH, deliberate confirm).
- **Getting work done** — hierarchical delegation; real actions (web fetch/search, file write,
  guarded `api_call`, `shell` on the VM); richer file types + export; keyword RAG memory.
- **Runs itself** — goals/OKRs with scheduled auto-advance, inbound triggers, notifications, and a
  self-optimizing loop (scorecards → HR recommendations → coaching lessons → goal retrospectives).
- **Deliverable lifecycle** — draft → QA'd → your sign-off → delivered, with versioning.
- **Dry-run mode**, **run history & replay**, **company templates**.
- **Multi-workspace** — each workspace is a fully isolated company.

---

## Parked / in flight

- **Paused background sessions** (delegation-breadth fan-out; paid per-agent model routing) — their
  partial work is already merged; the sessions themselves should not be resumed.
