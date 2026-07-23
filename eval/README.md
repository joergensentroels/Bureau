# Bureau eval / regression harness

An **offline** measurement of how reliably the three JSON-critical orchestration calls produce
parseable, schema-valid output — and how much the cheap paid Kimi tier improves that over the local
qwen3 model. It exists because the local model is flaky exactly at STRICT-JSON prompts, and one broken
object can collapse an entire delegation. This turns that flakiness into a number you can watch.

The three calls under test (the ones the weak model is worst at):

| Call | Prompt builder | What "valid" means |
|---|---|---|
| `deriveCriteria` | `buildCriteriaMsgs` | `{ "criteria": [...] }` with 3–6 non-empty items |
| `verifyRun` | `buildVerifyMsgs` | `{ "results": [{met,note}] }` — one per criterion, `met` boolean-ish |
| `delegate` decompose | `buildDecomposeMsgs` | `{ "tasks": [{assignee,task}] }` with ≥1 assignee resolvable to a real report |

## How it works (and why the numbers are trustworthy)

`run-eval.mjs` imports the **real** prompt builders, `safeParse`, the shape validators, and `askLlm`
from `../server.mjs`. The server module is import-safe — its bootstrap is guarded behind an `isMain`
check — so importing it never starts the server, opens the SQLite DB, writes drafts, or files
approvals. What's measured is therefore the *exact* production prompt run through the *exact*
production parser and the *exact* acceptance the orchestrator uses. There is no parallel copy to drift.

Each case runs `--reps` times (default 5) at temperature 0 through the same escalation ladder
production uses, so the reported rates are distributions, not single coin-flips.

### Metrics
- **single-shot** — parsed on the *first* token budget (raw model reliability).
- **effective** — parsed *anywhere* in the escalation ladder (what the operator actually gets).
- **schema-valid** — parsed **and** passed the production validator (valid JSON of the wrong shape fails).
- **fan-out** (decompose) — share of schema-valid plans that split work across ≥2 people.
- **verdict accuracy** (verify) — against hand-labeled expected met/unmet, so we measure whether QA is
  *correct*, not just whether it emits JSON.
- latency p50/p95, mean tokens, and paid $ spent.

## Usage

```sh
node eval/run-eval.mjs                  # local only (free), all call-types, 5 reps
node eval/run-eval.mjs --paid           # ALSO run the cheap paid Kimi tier (spends real cents)
node eval/run-eval.mjs --reps=8         # more reps → tighter rates on a noisy local model
node eval/run-eval.mjs --type=decompose # one call-type only (criteria|verify|decompose)
node eval/run-eval.mjs --save-baseline  # write the LOCAL rates to eval/baseline.json
node eval/run-eval.mjs --baseline       # compare LOCAL run to baseline; exit 1 on regression
node eval/run-eval.mjs --baseline --tol=0.2   # looser regression tolerance (default 0.15)
```

Requires Latch running (for `local`, the local model via ollama; for `--paid`, a configured paid
provider). `--paid` is opt-in and prints a call-count/cost heads-up first; without a paid provider it
falls back to local rather than silently mislabeling. Progress prints one char per rep:
`.` schema-valid · `x` parsed but wrong shape · `!` failed to parse.

## Files
- `cases.json` — hand-authored golden cases (keep small & high-signal; edit freely).
- `run-eval.mjs` — the runner.
- `baseline.json` — committed reference rates for `--baseline` (regenerate with `--save-baseline`).
- `reports/` — timestamped run outputs (gitignored).

## Regression gate
`--baseline` exits non-zero if any local rate drops more than `--tol` (default 0.15 absolute) below the
saved baseline — so it can gate a pre-commit hook or CI step later without further work. Because the
local model is noisy, use enough reps when saving a baseline (≥8 recommended).
