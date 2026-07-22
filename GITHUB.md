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
the document) or `github_repo` (title = new repo name). You approve in the Inbox (or
Latch/Compass), and Latch commits it. Restrict which agents may do this per-agent under
*Advanced → Allowed actions → 🐙 GitHub publish*.

## Status

`GET /api/integrations` reports whether the connector is configured (`github.configured`) and
this workspace's target — the token is never exposed (Latch redacts it).
