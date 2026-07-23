# Bureau — Security Model & Review

_Last reviewed: 2026-07-23. Bureau is the **control surface**; Latch (openclaw-command-center) is the
**credential-holding security boundary**. Read `openclaw-command-center/SECURITY.md` for the boundary
that actually holds your API keys, GitHub token, and mailbox — Bureau holds none of those._

## Trust & threat model

- Bureau binds **`127.0.0.1` only** (`server.mjs`, `server.listen(PORT, "127.0.0.1")`). It is not, and
  must not be, exposed on a public interface or a shared network.
- The threats that matter for a localhost service are **NOT** remote network attackers. They are:
  1. **Any local process** running as the operator.
  2. **Any website the operator visits** while Bureau is running — the browser will happily issue
     `fetch("http://127.0.0.1:4173/...")` (CSRF / drive-by / DNS-rebinding).
- Localhost binding stops (1)-from-other-hosts but does nothing against a hostile local process or a
  malicious web page. **Authentication is what closes those** — see below.

## Authentication (required)

Every `/api/*` and `/mcp` request must present the **operator token** — the *same* token Bureau uses
to authenticate to Latch (`data/auth.json` `operatorToken`, or the `OPERATOR_TOKEN` env var). One
operator credential for the whole control plane; Bureau already refuses to boot without it.

- Sent as `Authorization: Bearer <token>` (or `x-command-token`, or `?token=` for the SSE stream only,
  since `EventSource` can't set headers). Compared in constant time (`safeEqual`: SHA-256 +
  `timingSafeEqual`). Fails closed.
- **Exempt from the token gate:** the static UI shell (HTML/CSS/JS — no secrets) and
  `POST /api/trigger/:token` (external webhooks that carry their own 122-bit unguessable per-trigger
  token as their auth).
- Why a bearer token also kills CSRF/drive-by: a cross-site page cannot read or attach your token, and
  adding an `Authorization` header turns the request into a CORS *preflighted* request, which the
  server (sending no CORS headers) fails. Latch uses the same header-token approach for the same reason
  — it is why neither service needs CSRF tokens.

## The approval boundary (what protects real-world actions)

Bureau proposes actions → **Latch approves (human) → Latch executes with its credentials**. The
strongest control is the **hard floor**, `requiresCeoAlways` (`server.mjs`): `shell`, `api_call`,
`email_draft`, `github_repo`, and purchases over the ceiling / with no ceiling **always** require your
explicit approval in Latch — regardless of autonomy tier, `run.autoApprove`, or any policy `allow`
rule. **The hard floor is code, not editable data:** there is no API that mutates it. So even a fully
authenticated-but-hostile call cannot make Bureau shell out, hit an arbitrary API, send email, or make
a large purchase without you.

## Review findings (2026-07-23)

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | CRITICAL | No authentication on any endpoint | **FIXED** — operator-token gate on all `/api` + `/mcp` (`0311204`) |
| 2 | CRITICAL | No Origin/CSRF check; Content-Type-agnostic body parse → drive-by from any visited site | **FIXED** — bearer-token requirement closes it (see above) |
| 3 | HIGH | Security config (guardrail ceiling, policy `allow`, agent tier/allowlist) mutable unauthenticated → widen auto-approval | **MITIGATED** — now behind auth. _Future: treat config-mutation + steer as an operator-only role, distinct from a read/agent token._ |
| 4 | HIGH | Unauthenticated `autoApprove` runs (`/api/run`, goals/plan/sops); triggers fire auto-approve | **MITIGATED** — run-start now behind auth; triggers keep their own per-token auth |
| 5 | HIGH | `POST /api/run/:id/steer` injects text as trusted "CEO course correction" | **MITIGATED** — now behind auth. Residual (accepted): the *authenticated operator* can still steer, by design; steer text is deliberately high-trust framing, so only the operator should hold the token |
| 6 | — | Hard floor `requiresCeoAlways` uneditable via API | **Positive control** — unchanged; caps blast radius of 3–5 |
| 7 | MED | All company data readable + `/mcp` mirrors it | **MITIGATED** — now behind auth |
| 8 | MED | SSRF guard correct & applied, but DNS-rebinding TOCTOU between `assertPublicHost` check and `fetch` | **DEFERRED** — bounded: `api_call`/`shell` are on the hard floor (human-gated) already. _Fix later: pin the resolved IP for the actual connection._ |
| 9 | LOW | `ask_peer` well-contained (persona-only, local, no actions, no recursion); SOP runs don't bypass the approval gate | **Accepted** — no action needed |

## Remaining hardening (backlog, none critical)

- **DNS-rebinding TOCTOU** (Finding 8): resolve the host once and connect to that pinned IP.
- **Bind-guard**: refuse to start bound to a non-loopback interface unless a token is explicitly set
  (defense-in-depth against a future `HOST=0.0.0.0` misconfiguration).
- **Role separation**: Bureau uses a single operator token. Latch has operator/agent/draft/user roles;
  Bureau could add a read-only token and an operator-only class for config-mutation + steer.
- **Server-side spend ceiling / rate limits**: Latch enforces credit reservation (402) and email
  rate limits (429). Bureau relies on the per-run action cap + the auto-approve ceiling + the hard
  floor; consider a server-side per-run/day spend cap for paid-model budget.
- **`?token=` in the SSE URL** can appear in local server logs. Acceptable for a localhost operator
  token; revisit if Bureau ever moves off loopback.

## Operating guidance

- Keep Bureau on **loopback**. Do not port-forward, reverse-proxy publicly, or bind `0.0.0.0`.
- Treat the operator token like the Latch operator token — it *is* the same token. Anyone with it has
  full control-plane authority (short of the hard-floored actions, which still need interactive Latch
  approval).
- MCP clients must send `Authorization: Bearer <operator token>` to `http://127.0.0.1:4173/mcp`.
