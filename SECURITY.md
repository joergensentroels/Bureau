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

- Sent as `Authorization: Bearer <token>` or `x-command-token` — **headers only, never a query param**
  (a token in a URL is copied into the access log of every proxy/tunnel/CDN in the path). The SSE run
  stream is therefore read with `fetch()` in the UI rather than `EventSource`, which cannot set headers.
  Compared in constant time (`safeEqual`: SHA-256 + `timingSafeEqual`). Fails closed.
- **Rejected credentials are counted per client address**, refused with `429` past `AUTH_FAIL_MAX` (10)
  inside a 10-minute window, and written to the audit log (`kind: "auth"`) plus the console. The token
  is far too large to guess — this exists for the *alarm*, so a sustained probe is visible rather than
  silent. Any success clears that address's counter.
- **The alarm is rate-limited too**, at most two rows per address per window (burst opening, and the
  moment refusal starts), with one closing summary carrying the true total when the window ends. This is
  not cosmetic: logging every Nth failure let a single browser tab polling with a stale token generate
  ~4000 failures and 400 audit rows in 48 minutes, which would hide exactly the probe the log exists to
  reveal. The UI cooperates by pausing its background pollers while auth is refused.
- **Exempt from the token gate:** the static UI shell (HTML/CSS/JS — no secrets) and
  `POST /api/trigger/:token` (external webhooks that carry their own 122-bit unguessable per-trigger
  token as their auth).
- Why a bearer token also kills CSRF/drive-by: a cross-site page cannot read or attach your token, and
  adding an `Authorization` header turns the request into a CORS *preflighted* request, which the
  server (sending no CORS headers) fails. Latch uses the same header-token approach for the same reason
  — it is why neither service needs CSRF tokens.

## External MCP tools (`mcp_call`)

Agents can call external MCP tools, but the design keeps the trust boundary at Latch. `mcp_call` is
**hard-floored** (`requiresCeoAlways`): Bureau only ever *files* a Latch `mcp_tool_call` approval and
waits — it never auto-approves, because Bureau holds the operator token and an auto-approve would let
it `PATCH`-approve the Latch approval and bypass Latch's per-tool allowlist + tool-definition
fingerprint (rug-pull) guard. Latch runs the tool on the trusted host with the server's own
credentials (Bureau never sees them) and returns only the result, which the agent receives **framed as
untrusted external data**. Bureau opens no outbound MCP connections. When MCP is unconfigured on the
host, the capability is dormant (never advertised to agents).

## One deliberate exception to "all model access goes through Latch"

Chat completions go through Latch because Latch holds the provider keys. **Embeddings do not**: the
embedder is a local, keyless model, so there is no credential for Latch to protect and nothing leaves
the machine. Bureau calls it directly at `BUREAU_EMBED_URL` (default `http://127.0.0.1:11434`), and
warns on startup use if that URL is not loopback.

This deliberately does **not** use `pinnedRequest`. That SSRF guard refuses private IPs and exists for
URLs an *agent* supplies; this URL is operator configuration and is never model-controlled. Anything
credentialed or outward-facing still goes through Latch. If you ever point `BUREAU_EMBED_URL` at a
remote embedder, note that memory text then leaves the host — which is why the warning exists.

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
| 8 | MED | SSRF guard correct & applied, but DNS-rebinding TOCTOU between the check and `fetch` | **FIXED for `web_research`** (`dd8c7c1`) — `fetchUrl` uses core http/https with a `pinnedLookup`: one resolution validates AND supplies the connect IP (no rebinding window); IP literals validated directly. `api_call` still uses `assertPublicHost`+`fetch` — accepted, since it's hard-floored (human-approved); pin it too as a follow-up. |
| 9 | LOW | `ask_peer` well-contained (persona-only, local, no actions, no recursion); SOP runs don't bypass the approval gate | **Accepted** — no action needed |
| 10 | LOW | Clickjacking: with the token now in the browser, a page could frame Bureau and trick authed clicks | **FIXED** (`dd8c7c1`) — `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` (plus `nosniff`, `no-referrer`) on every response |

## Hardening — all backlog items done

- **DNS-rebinding pin (both outbound paths)** — `fetchUrl` (`dd8c7c1`) and `apiCall` (`f0c7c56`) use
  core http/https with a validating `pinnedLookup`: one resolution validates *and* supplies the connect
  IP; IP literals validated directly. No rebinding window.
- **Anti-clickjacking + nosniff headers** (`dd8c7c1`): `X-Frame-Options: DENY`, CSP `frame-ancestors
  'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` on every response.
- **Off-loopback bind-guard** (`dd8c7c1`): `BUREAU_HOST` (default loopback); loud SECURITY warning if
  bound to a non-loopback interface.
- **Server-side per-run paid ceiling** (`f0c7c56`): guardrail `maxPaidUsdPerRun` (0 = unlimited);
  `canUsePaid` + `orchestrationRouting` fall back to local once the run's total paid spend reaches it.
- **Role separation** (`f0c7c56`): a read-only token (Latch `agentToken` / `BUREAU_READ_TOKEN`) grants
  `readonly` — reads + read-only MCP tools only; mutations, run-starts, steer, config, and MCP
  `run_sop`/`start_run` require the operator token.

- **Tokens are header-only** (2026-07-25): `?token=` is no longer accepted anywhere, including the SSE
  stream; the UI reads the stream with `fetch()` + a stream reader instead of `EventSource`. Removes the
  last path by which the operator token could land in an access log.
- **Failed-auth damper + audit** (2026-07-25): per-address failure counter, `429` past 10 failures in 10
  minutes, every burst recorded in the audit log as `kind: "auth"` / `actionType: "auth_failed"`.
- **Role introspection** (2026-07-25): `GET /api/whoami` returns the caller's role so the UI can label
  itself read-only and explain a refusal, making the read-only token a usable everyday mode.

### Residual (accepted)

- **Single-host token store**: Bureau reuses Latch's `data/auth.json` tokens. Rotating there rotates
  both — intended (one operator identity for the control plane).

## Reaching Bureau from another machine

Bureau's threat model above assumes loopback. Reaching it from elsewhere changes one thing that matters
more than the network: **the operator token is Latch's operator token, and it can approve hard-floor
approvals** via `POST /api/approvals/:id/decide`. The hard floor stops a rogue *agent*; it does not stop
a human holding the token. So a leaked operator token on a remote/untrusted machine is equivalent to
code execution on the Bureau host. Rules that follow:

1. **Never expose Bureau directly.** No port-forward, no public reverse proxy, no `0.0.0.0`. Bureau
   speaks plain HTTP and has no TLS of its own — confidentiality must come from the transport.
2. **Use an identity-gated overlay or tunnel**, so unauthenticated traffic never reaches Bureau at all:
   a private mesh (Tailscale/WireGuard), or an outbound tunnel with an identity proxy in front
   (Cloudflare Tunnel + Access). Both let Bureau stay bound to `127.0.0.1` — the tunnel daemon is the
   only thing that connects to it, so the bind-guard warning never even applies.
3. **Give a less-trusted browser the read-only token** (Latch's `agentToken` / `BUREAU_READ_TOKEN`), not
   the operator token. You keep full visibility — runs, feed, deliverables, audit — and the UI badges
   itself `👁 read-only` and explains refusals. A token sitting in a managed work browser's
   `localStorage` is readable by that machine's management tooling; make it the harmless one.
4. **Approve hard-floor actions from the trusted host.** If you do use the operator token remotely,
   understand you have moved shell-approval authority to that browser. **Set `BUREAU_REMOTE=1`** (below)
   so Bureau refuses to be the instrument.

### `BUREAU_REMOTE=1`

Bureau's in-app approval seam (`POST /api/approvals/:id/decide`) performs the same Latch `PATCH` as an
auto-approval. That means a browser holding the operator token can turn "read my company's state" into
"run a shell command on the host" — the sharpest edge in the system once Bureau is reachable from
somewhere you trust less. With `BUREAU_REMOTE` set, the seam may still **deny** anything (de-escalation
is always safe) but may only **approve** actions on an allowlist; everything else is decided in
Latch/Compass on the trusted host.

- The allowlist is `SAFE_TIER_ACTIONS` — `web_search`, `web_research`, `read_file`, `file_write`,
  `note`, `ask_peer` — plus a `purchase` under the configured ceiling. This is **stricter than the hard
  floor**: `github_file` is not hard-floored (a commit is reversible via git history) but is excluded
  anyway, because it writes outward with Latch's credential.
- **It is an allowlist, not a hard-floor lookup, on purpose.** Asking "is this hard-floored?" answers
  "no" for anything it doesn't recognise, so a newly added action type would be remotely approvable
  until someone remembered to classify it. Inverting it makes the default safe.
- **Fails closed.** An approval whose originating action can't be established is refused. Provenance
  comes from the `act-<type>` tag `fileApproval` stamps on every approval, because Latch's own `type` is
  too coarse to use — `web_search`, `shell` and `api_call` all arrive as `type: "command"`.
- **Honest scope: defence in depth, not a boundary.** The operator token is Latch's own token, so
  whoever holds it can approve directly in Latch wherever Latch is reachable. What this buys is that
  Bureau stops being an amplifier, and the recommended posture (read-only token on the remote browser)
  becomes enforced rather than merely advised.

_Live-verified against a real Latch (2026-07-30): an `act-shell` approval is refused with `403
remote_mode_hard_floor` and recorded in the audit log, denying it still returns 200, an `act-note`
approval still approves, and an untagged approval is refused rather than allowed._

> **Latch sanitises `contextTags`**: colons are stripped, tags are lowercased, tags containing spaces
> are dropped. Bureau therefore uses a hyphen separator (`ws-`, `agent-`, `act-`) via the `mkTag` /
> `readTag` helpers. This was found while building the above — the previous colon form meant
> `ws:default` was stored as `wsdefault`, so the Inbox's per-workspace filter had never matched.

**One consequence of proxying:** requests arriving through a tunnel reach Bureau from `127.0.0.1`, so
the failed-auth damper cannot tell remote clients apart — every proxied caller shares one counter with
the local machine. A remote probe therefore trips the damper for local unauthenticated requests too.
This can't lock you out (a valid token is never throttled, and any success clears the counter), but it
does mean a `429` where you'd expect a `401`; the UI explains that state and clears the stored token so
the next load re-prompts. Keying on a proxy-supplied identity header would restore per-client
granularity — deliberately not done, since a header is only as trustworthy as the proxy in front.

_Verified end-to-end over `tailscale serve` (2026-07-25): HTTPS with a valid cert, the `Authorization`
header survives the proxy, the read-only token reads but cannot write, and the SSE live feed streams
incrementally rather than being buffered (a real run arrived in 7 chunks with gaps up to 22s)._

## Operating guidance

- Keep Bureau on **loopback** (see above for the one safe way to reach it from elsewhere).
- Treat the operator token like the Latch operator token — it *is* the same token. Anyone with it has
  full control-plane authority, and can approve the hard-floored actions interactively.
- MCP clients must send `Authorization: Bearer <operator token>` to `http://127.0.0.1:4173/mcp`.
