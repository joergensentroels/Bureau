# Contributing to Bureau

Thanks for taking a look. Bureau runs a hierarchy of AI agents that take **real,
approval-gated actions**, so contributions are very welcome — with a couple of
non-negotiables that keep the gate meaningful.

## Before you start

- Read [README.md](./README.md) for what Bureau is, and [SECURITY.md](./SECURITY.md)
  for the trust model. Most design decisions here exist to serve that model; a
  change that weakens it will be declined even if it's otherwise nice.
- Bureau needs **[Latch](https://github.com/joergensentroels/Latch)** running
  alongside it. Latch is the security boundary that holds every credential and
  executes the risky actions; Bureau stores no secrets and will not start without it.
- **Node 24+** (`node:sqlite` is used unflagged).
- By contributing you agree your changes are licensed under the project's
  **AGPL-3.0-or-later** (see [LICENSE](./LICENSE)).

## The one architectural rule

**Bureau proposes; Latch approves and does.** Bureau holds the operator token, which
is what makes the rule load-bearing rather than decorative:

- **No credentials in Bureau.** Provider keys, the GitHub token and the mailbox live
  in Latch. Don't add a path where Bureau reads or forwards one.
- **The hard floor is code, not configuration.** `requiresCeoAlways()` in
  `server.mjs` forces a human decision for `shell`, `api_call`, `email_draft`,
  `github_repo`, `github_pr`, `mcp_call` and over-ceiling purchases — regardless of
  autonomy tier, `run.autoApprove`, or any policy rule. It is deliberately not
  reachable from any API. Adding an action with real-world reach means adding it
  here too, and saying why if you don't.
  **Floored is not the same as offered:** `email_draft` is on this list but has no
  executor and is no longer in the response schema enum, so no agent can propose it.
  Don't tidy it off the floor — the floor's job is to be shut *before* something
  needs it, including for approvals filed by older builds. And the converse is now
  mechanical: `test/action-surface.test.mjs` fails if any actionType the model can
  reach has no dispatch branch and no entry in `UNEXECUTED_ACTIONS`.
- **Bureau must never approve its own Latch approval.** It has the operator token,
  so it *could*; that is precisely why `mcp_call` and the GitHub write actions are
  hard-floored. Auto-approval would bypass Latch's per-tool allowlist and its
  tool-definition fingerprint guard.
- **What the operator reads is what executes.** `github_pr` carries the files inside
  the approval so there's no second fetch between the decision and the write. Keep
  that property in anything similar.
- **Model output is untrusted input.** Results from `web_research`, `read_issues` and
  `mcp_call` come back explicitly framed as untrusted, as does the body of an inbound
  trigger. Don't unwrap that framing.

## Conventions

- **Node built-ins only.** `server.mjs` has zero runtime npm dependencies, on
  purpose. Please don't add one without discussing it first — it's a design
  property, not an oversight.
- **No secrets or runtime state in the repo.** `data-bureau.db`, `drafts/`,
  `agent-profiles/`, `_backups/` and the logs are gitignored and must stay that way.
- **`.ps1` files stay ASCII in strings.** PowerShell 5.1 reads a BOM-less script as
  CP1252, so a UTF-8 em-dash inside a double-quoted string terminates it and spills
  the rest of the line out as code. Comments are fine; strings are not.
- Match the surrounding style: small readable functions, and comments that explain
  *why* — especially for anything security-relevant.

## Running the tests

```bash
node test/run-all.mjs --serve
```

That is **the** command: it self-hosts a throwaway server on a free port of its own
(generating its own operator token, so no Latch needed), runs the pure and server
suites, and tears down. It's what the pre-push hook and CI run. Set `BUREAU_PORT` if
you want a known port; otherwise two concurrent runs — several worktrees off one
clone, each with a pre-push hook — deliberately never share one. See
[TESTING.md](./TESTING.md) for what sharing one cost.

```bash
node test/coverage-audit.mjs   # every exported fn + route must be tested or documented
node test/run-all.mjs --e2e    # live autonomy e2e; needs Latch + a local model, ~13 min
```

Enable the pre-push gate once per clone:

```bash
git config core.hooksPath .githooks
```

**If you change security-relevant behaviour, add or update a test**, and keep the
coverage audit green — no new export or endpoint ships without a test or an entry in
[TESTING.md](./TESTING.md) explaining why it's manual.

**Anything in the pre-push/CI set must be hermetic.** CI has no Bureau, no Ollama, no
Latch and no network — if a test needs one, stub it or point it at a closed port. The
local hook cannot catch a violation, because a maintainer's machine is the one place
the dependency is satisfied: a test that reached the default Bureau URL passed here
and on every fresh clone that happened to have Bureau running, while turning CI red on
every push for ninety minutes. Live-service tests belong in `e2e-autonomy.mjs`, which
is `--e2e` only and outside both gates by design.

## Submitting a change

1. Keep pull requests focused — one coherent change per PR.
2. Run `node test/run-all.mjs --serve` and make sure it's green.
3. In the PR description, say what the change does and — if it touches actions,
   approvals, the hard floor, or the Latch seam — how it affects the trust boundary.
4. Say whether it needs a restart or a re-install of the boot tasks, so a self-hoster
   knows what to do after pulling.

## Reporting security issues

Please **don't** open a public issue for a vulnerability. Use the private path at the
top of [SECURITY.md](./SECURITY.md) (GitHub Security Advisories) so it can be fixed
before it's disclosed. If it concerns credential handling rather than Bureau's gate,
it probably belongs in [Latch](https://github.com/joergensentroels/Latch) instead.
