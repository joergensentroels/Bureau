# Bureau, in a container.
#
# NOT BUILT OR RUN YET. No container runtime exists on the machine this was written on (docker, podman
# and compose all absent; WSL has no distro), so this is reviewed and reasoned but unexercised.
# docker/README.md lists exactly what the first real build has to settle.
#
# No build stage and no package install: Bureau has ZERO runtime dependencies, so this image is the Node
# base plus this repo's own source. Nothing transitive, no lockfile to audit, no package manager left in
# the runtime layer.
#
# Same digest as the Latch image, on purpose -- one base across both services means one thing to re-pin
# and one CVE feed to follow. Resolved from Docker Hub on 2026-08-20; `node:24-bookworm-slim` is mutable,
# and a tag would make "the image we reviewed" and "the image we run" quietly different things.
FROM node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# Node 24 is a floor, not a preference: package.json requires >=24 because Bureau uses node:sqlite.
ENV NODE_ENV=production \
    BUREAU_PORT=4173 \
    BUREAU_HOST=0.0.0.0 \
    BUREAU_REMOTE=1 \
    LATCH_URL=http://latch:8787

# BUREAU_REMOTE DEFAULTS ON IN THE IMAGE, matching Start-Bureau.ps1's posture and for the same reason.
# A container is reachable from outside its own namespace by definition -- that is what publishing a port
# means -- so the guard that keeps hard-floor actions from being approved through Bureau's own UI should
# be the default state, and turning it OFF should be the thing someone has to type. A safety posture that
# depends on the launcher remembering to set it is a posture that disappears on the first deployment
# nobody read.
#
# LATCH_URL points at the compose service name, not 127.0.0.1. This is the whole architectural change:
# Bureau reaches the credential boundary over the network and has no path to its filesystem.

WORKDIR /app

COPY . /app

# --- THE HONEST LIMITATION, stated where someone changing this file will see it -----------------------
#
# /app is writable by the app user, and Latch's equivalent is not. That asymmetry is real and it is not
# an oversight: Bureau writes its state INTO ITS OWN SOURCE DIRECTORY -- data-bureau.db,
# data-bureau.json, data-bureau-workspaces.json, agent-profiles/, drafts/, bureau.log -- so the directory
# holding the code must be writable for the process to start at all.
#
# Two consequences, both worth knowing before trusting this image:
#   1. `read_only: true` is NOT possible for this service, while it is for Latch.
#   2. A compromised Bureau process can rewrite its own source. Latch's cannot.
#
# The fix is a code change and not a packaging one: route those paths through a single BUREAU_STATE_DIR
# (defaulting to HERE, so bare-metal behaviour is unchanged), then /app goes back to root-owned and
# read-only with one named volume at the state directory. Until that lands, this file should not pretend
# otherwise -- see docker/README.md, "Known gaps".
RUN chown -R node:node /app

USER node

EXPOSE 4173

# UNAUTHENTICATED BY DESIGN, and that is the requirement rather than a shortcut. "/" is the static shell
# and is deliberately not token-gated (test/run-all.mjs relies on the same property); every /api/* route
# would answer 401 and read as "unhealthy". A healthcheck carrying the operator token would put that
# token into the image config, into `docker inspect`, and into the process list on every probe.
#
# So this proves Bureau is answering HTTP and nothing more. It is deliberately NOT a liveness claim about
# the model or about Latch: this repo has already paid for a probe that pinged a port while every
# inference returned 500 for nine hours. Depth belongs in an authenticated check the operator runs, not
# in a credential-free loop the daemon runs every 30 seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BUREAU_PORT||4173)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
