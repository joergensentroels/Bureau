# Tests

Coverage for Bureau's safe-autonomy stack — the layered approval model
(**per-agent allowlists → autonomy tiers → declarative policy rules**) under one
inviolable **hard floor** (`shell`, `api_call`, `email`, and over-ceiling spend
always require the CEO).

## `decision.test.mjs` — pure unit tests (fast, no server)

Exercises the decision core directly via the functions `server.mjs` exports —
`decideApproval()` and `evaluatePolicy()`. No server, no Latch, no model.

```
node test/decision.test.mjs
```

Covers the tier truth table, the hard floor under every tier and under run-level
auto-approve, policy matching / first-match-wins / disabled-rule skipping, and the
precedence rule **tier grants → policy loosens/tightens → floor clamps** — including
the guarantee that a policy `allow` can never auto-approve a floored action.

## `e2e-autonomy.mjs` — live end-to-end (needs a running server + Latch + model)

Drives real company runs and asserts the layers compose:
tier auto-approve → a policy `require` override → the **in-app approval seam** →
the Definition-of-Done verdict → a policy `block`.

```
BUREAU_PORT=4174 node server.mjs          # in one shell
BUREAU_PORT=4174 node test/e2e-autonomy.mjs   # in another
```

The runs are real: they create deliverables in `drafts/` and file/resolve Latch
approvals. The test discovers an agent from the org, restores its tier, and clears
the policies it adds — but it does **not** delete the `welcome-*` / `thank-you-*`
drafts it produces, so remove those by hand if you don't want the sample output.

## `workspaces.test.mjs` — workspace isolation (needs a running server)

Proves each workspace is a fully separate company: new workspaces start empty,
writes to one never touch another (or the default), an unknown workspace id falls
back to default, and delete removes a workspace's data while leaving default intact.
Uses only throwaway workspaces it creates and deletes — it never mutates default.

```
BUREAU_PORT=4174 node server.mjs
BUREAU_PORT=4174 node test/workspaces.test.mjs
```
