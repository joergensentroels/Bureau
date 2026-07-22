# GitHub publishing — setup

Bureau agents can publish work to GitHub (a `github_file` commits a file; `github_repo`
creates a repo). **Bureau never stores a GitHub token** — Latch holds it and performs the
commit after you approve. Every GitHub action is approval-gated (hard floor: never
auto-approved, not even for an autonomous agent or a policy `allow`).

Bureau only stores, per workspace, *which repo/owner to target* (names, not secrets).

## One-time setup (dedicated org — recommended)

Do these on your side; Bureau needs none of the secrets.

1. **Create a GitHub organization** for the agent company (github.com → your profile →
   *Your organizations* → *New organization*). This keeps agent-created repos separate from
   your personal account and lets you scope/revoke access cleanly.

2. **Create a fine-grained personal access token** scoped to that org:
   - *Resource owner*: the org.
   - *Repository access*: all repos (or select).
   - *Permissions*: **Contents → Read and write** (to commit files), and
     **Administration → Read and write** (only if you want agents to create new repos).

3. **Register it in Latch** (the token lives here, not in Bureau):
   ```
   ./Configure-GitHub.ps1 -Owner <your-org> -OwnerType org -PromptForToken
   ```
   (paste the token at the secure prompt; optionally `-DefaultRepo <name>`.)

4. **Point the workspace at it in Bureau**: open **🛡️ Guardrails → 🐙 GitHub target** and set
   *owner* (the org) and *repo*. Each workspace can target a different repo/owner; leave blank
   to use Latch's default. This is per-workspace, so different companies can publish to
   different places.

## Using it

An agent proposes a `github_file` (title = repo file path, e.g. `reports/q3.md`; content =
the document) or `github_repo` (title = new repo name). Latch commits it. Restrict which
agents may publish at all under *Advanced → Allowed actions → 🐙 GitHub publish*.

## Autonomy vs. protection — where the guard lives

File commits (`github_file`) are **not** hard-floored — they follow the normal autonomy model:

- **Supervised** agent → each commit still asks you.
- **Autonomous** agent (or a policy rule `allow github_file`) → commits go through **without asking**.

So to let agents publish freely, set the relevant agents to **Autonomous** (or add one policy
rule allowing `github_file`). Then protect only the repos that matter — **on GitHub, not in
Bureau**: enable **branch protection / required pull-request review** on the important repo's
default branch. Latch commits directly (it doesn't open PRs), so a protected branch simply
**blocks** an agent's commit — nothing lands in your product repo without you, while sandboxes
and working repos get full autonomy.

Creating a **repo** (`github_repo`) always asks you — that's still hard-floored.

## Status

`GET /api/integrations` reports whether the connector is configured (`github.configured`) and
this workspace's target — the token is never exposed (Latch redacts it).
