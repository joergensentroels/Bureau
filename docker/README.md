# Bureau + Latch in containers

**Nothing here has been built or run.** The machine this was written on has no container runtime —
`docker`, `podman` and `compose` are all absent, and WSL has no distro installed. Every file in this
directory is reviewed, reasoned, and statically checked; none of it is exercised. [First build](#first-build)
lists what to settle the moment a runtime exists.

What *is* verified is the code underneath it, by three suites in the pre-push gate — all three
negative-controlled, and counts deliberately not quoted here because nothing would check them:

- `test/secret-tokens.test.mjs` — credential provenance, and that the strong source cannot degrade
- `test/state-dir.test.mjs` — that `BUREAU_STATE_DIR` relocates state and that its default did not move
- `test/compose-boundary.test.mjs` — this compose file, against the properties it exists to hold

## Why two containers

Bureau currently reads `<latch>/data/auth.json` off the disk to get its two tokens. That makes the
credential boundary a *convention* — Bureau opens one file in that directory because that is what the
code happens to do, and it could open any other file there just as easily. Nothing prevents it.

Two containers with no shared mount, tokens delivered as secrets, and Latch reached by service name turn
that convention into something the runtime enforces. `BUREAU_STATE_DIR` is what made the second column
possible: with every mutable path collected under one directory, Bureau's source tree can be root-owned
and immutable, so a compromised process cannot rewrite its own code.

| | Latch | Bureau |
|---|---|---|
| Credentials at rest | **yes — the only one** | none |
| Writable path | `/app/data` (volume) | `/app/state` (volume) |
| Gets its tokens from | its own `data/` | `/run/secrets/*`, tmpfs |
| Reaches the other via | — | `http://latch:8787` |
| Root filesystem | **read-only** | **read-only** |
| Published on | `127.0.0.1:8787` | `127.0.0.1:4173` |
| Capabilities | `cap_drop: ALL` | `cap_drop: ALL` |

### The mistake this is arranged to prevent

The first time someone hits `Could not load Latch's operator token` in a container, the obvious fix is to
bind-mount Latch's data directory into Bureau so `LATCH_DATA` works again. The error goes away, the stack
starts, every check passes — and the result is two containers occupying **one** trust domain, with
exactly the security properties of the single-process version, for the price of a harder deployment.

Nothing about the running system looks different. That is why it is a test and not a comment:
`test/compose-boundary.test.mjs` fails if `LATCH_DATA` appears in the bureau service, if bureau
references Latch's repo path, if the two services share a named volume, or if any port stops being bound
to `127.0.0.1`.

## Secrets

Generate them once, on the host, after Latch has booted and written its `auth.json`. This never prints a
token — it copies values between files:

```bash
node -e "const a=require('fs');const j=JSON.parse(a.readFileSync(process.argv[1],'utf8'));a.writeFileSync('docker/secrets/operator_token',j.operatorToken);a.writeFileSync('docker/secrets/read_token',j.agentToken||'');console.log('wrote 2 secret files, printed neither')" "../openclaw-command-center/data/auth.json"
```

`docker/secrets/.gitignore` denies everything but itself, so these cannot be committed. Compose mounts
them at `/run/secrets/` on a tmpfs, which never touches disk.

Environment variables would have been easier and are the wrong mechanism: an env var is inherited by
every child process a service spawns, readable at `/proc/<pid>/environ` by anything in the container,
printed back by `docker inspect` and `docker compose config`, and preserved into crash dumps. Bureau
still accepts `OPERATOR_TOKEN` for bare-metal convenience — the `_FILE` form takes precedence.

A named `*_FILE` that is **missing or empty fails the boot**. It does not fall back to `auth.json`, even
when a perfectly valid one is present. A deployment that silently downgrades has lost the property it was
configured to have while looking identical at runtime, which is the one failure a security seam cannot
afford.

## Run it

```bash
docker compose -f docker/compose.yaml up --build
```

`LATCH_CONTEXT` overrides where the Latch repo is (default `../../openclaw-command-center`).

Bureau's boot line reports which source each credential came from — never the value. If it says
`Latch's auth.json` inside a container, the secrets did not arrive and the boundary is not what you think.

## Known gaps

**1. Egress is unrestricted.** `internal: true` would be stronger, but Latch is the external LLM gateway
and reaches paid providers, while Bureau reaches Ollama on the host. Splitting that correctly requires
knowing which service may talk to which provider — operator knowledge, not inferable from this repo. Left
open rather than half-done, so the network is not mistaken for locked down.

**2. The finding gate needs `git` and a target checkout.** Bureau's review subsystem builds a real git
worktree of the repo under review. Whether `node:24-bookworm-slim` ships `git` is unconfirmed, and the
repos under review are not in the image regardless. A containerised Bureau can serve its UI and run
schedules; the hunt path needs either `git` installed and the repos mounted, or to stay on bare metal.

## First build

Nothing below has been observed. In rough order of how likely each is to bite:

1. **Does `COPY` bring everything needed?** Both `.dockerignore` files are deny-first allowlists derived
   from `git ls-files` plus every local import (neither repo has dynamic imports). A miss fails loudly
   with `MODULE_NOT_FOUND` naming the file — the intended failure mode, chosen over a denylist that leaks
   silently.
2. **Do BOTH start under `read_only: true`?** Bureau only just became able to — `BUREAU_STATE_DIR`
   collects its database, org blobs, drafts and profiles under `/app/state`, and the compose file
   cross-checks that the volume is mounted at exactly that path (a drift there loses every workspace on
   the next recreate, silently). Latch should be fine — it writes only inside `data/`, and `LATCH_LOG` is
   pointed into that volume. That variable is load-bearing: without it Latch tries to write `latch.log`
   into the read-only source tree and dies on boot. An earlier pass over the write paths missed it,
   because the grep looked at `writeFile`/`mkdir` and the log is opened through neither.
3. **Does `cap_drop: ALL` leave both able to bind their ports?** 8787 and 4173 are unprivileged, so it
   should, but this is the sort of thing that is cheap to check and expensive to assume.
4. **Do the healthchecks pass?** Both are credential-free by necessity — a token in a `HEALTHCHECK`
   lands in the image config and in the process list of every probe. They prove HTTP is answering and
   nothing more, deliberately: this repo has already paid for a probe that pinged a port while every
   inference returned 500 for nine hours.
5. **Does Bureau reach Ollama at `host.docker.internal:11434`?** `extra_hosts: host-gateway` is meant to
   cover it. Ollama holds the GPU as a SYSTEM task on the host; containerising it would mean GPU
   passthrough, which is a much larger job.
6. **Re-pin the base image.** Both Dockerfiles pin
   `sha256:3638d9a6…`, resolved from Docker Hub on 2026-08-20. A tag would make "the image we reviewed"
   and "the image we run" quietly different things. Updating it should be deliberate: re-resolve, read
   what changed, edit the line.
