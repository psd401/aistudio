# PSD AI Agent Platform — Base Docker Image
# Built on OpenClaw for AgentCore Runtime (ARM64)
#
# Build:
#   docker build --platform linux/arm64 -t psd-agent-base:latest .
#
# Push to ECR:
#   aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com
#   docker tag psd-agent-base:latest <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/psd-agent-base-dev:<TAG>
#   docker push <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/psd-agent-base-dev:<TAG>

# Pin base image to a known-good immutable digest.
#
# Pinned to OpenClaw 2026.6.11 — the latest stable release (cut 2026-06-30),
# bumped from 2026.4.20 for issue #1082. Digests verified 2026-06-30.
#
# Background — why the old 2026.4.20 pin existed: `:latest` floated through
# 2026.4.21–2026.4.23 and broke the runtime twice:
#   - Morning Brief cron: harness adapter "chat deadline expired" (no final event)
#   - 4/24: ENOENT on rename to '/home/node/.openclaw/.openclaw/workspace-state.json'
#     Our workspace is the `.openclaw`-suffixed path (openclaw.json), which
#     triggered upstream's OPENCLAW_HOME double-nesting bug (issues #44783/#45765).
#
# Why 2026.6.11 is safe to bump to:
#   - The double-nesting fix merged upstream as PR #93520 ("fix(workspace):
#     store setup state outside workspace dot-dir", merged 2026-06-16) and is
#     present in 2026.6.9+. Confirmed by commit ancestry — merge commit
#     52280351bb53 is an ancestor of v2026.6.9 / v2026.6.10 / v2026.6.11; it is
#     NOT in v2026.6.8 or earlier. The earlier targeted fix PRs
#     (#45793/#46016/#47298/#45784) and #53326/#44806 were all closed UNMERGED
#     — do not rely on those numbers.
#   - The "chat deadline expired" Morning Brief failure is NOT confirmable from
#     source. 2026.6.11 ships many gateway/session/chat-delivery fixes that
#     plausibly cover it, but it MUST be re-confirmed by the Morning Brief
#     smoke test (docs/operations/agent-platform-setup.md) before trusting it.
#
# Multi-arch index digest (Docker picks arm64 at build time via --platform):
#   ghcr.io/openclaw/openclaw:2026.6.11
#   index: sha256:3814fb1f62f9cfc5944de088c5817c68c88b5d721feebe36420b666a90a61ce7
#   arm64: sha256:0d5a5edced0af33baea44e0612d72f4d2cf75251613b48ea68ca14727faf2373
#
# Rollback target (previous good pin):
#   2026.4.20  index sha256:5db497263e85f266142ed6206644de4e401c5906cce835865981113c11486d64
#
# DO NOT revert to `:latest` or bump without (a) confirming the workspace
# double-nesting fix by commit ancestry and (b) a clean end-to-end test that
# includes the Morning Brief payload — a trivial "respond OK" prompt masks
# session-completion regressions.
FROM ghcr.io/openclaw/openclaw@sha256:3814fb1f62f9cfc5944de088c5817c68c88b5d721feebe36420b666a90a61ce7

# Switch to root for installations
USER root

# Base OS packages FIRST so the checksum-verified installs below have the
# tooling they need: `unzip` for bun's .zip release artifact, `curl` +
# `ca-certificates` for the downloads, and the python3 venv stack for the
# AgentCore SDK. (The exact Python version tracks the base image's distro;
# verify with: docker run --rm psd-agent-base:latest python3 --version)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv tzdata ca-certificates curl unzip && \
    rm -rf /var/lib/apt/lists/*

# Pin versions for supply-chain safety. Update these as needed.
ARG BUN_VERSION=1.2.12
ARG UV_VERSION=0.7.9

# bun (JS/TS runtime) and uv (Python package manager) install from their
# official GitHub release artifacts with SHA256 verification — NOT via
# curl-pipe-bash. A CDN/DNS compromise of bun.sh / astral.sh would otherwise
# substitute attacker binaries into every agent container, which holds IAM
# reach to psd-agent-creds/${env}/* and psd-agent/${env}/* secrets. (Same
# verified-download pattern as the gws and gh binaries below.)
#
# The SHA256 values are the published release checksums for the currently
# pinned versions (aarch64 = the ARM64 AgentCore runtime). When bumping a
# version, refresh the matching hash from the release:
#   bun: github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt
#        (the `bun-linux-aarch64.zip` line — glibc, NOT the -musl variant)
#   uv:  github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz.sha256
ARG BUN_SHA256=c898a2057f919b700bf289d843dae49ee114c8f625c7c1fed043790f54694509
ARG UV_SHA256=23242a8051e2191ed8d61f71a6792f2fc069ef18e6cdf07dedac3d3f648643c5
RUN set -eux; \
    curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64.zip"; \
    echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun-extract; \
    install -m 0755 /tmp/bun-extract/bun-linux-aarch64/bun /usr/local/bin/bun; \
    rm -rf /tmp/bun.zip /tmp/bun-extract; \
    bun --version; \
    curl -fsSL -o /tmp/uv.tar.gz \
      "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz"; \
    echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /tmp; \
    install -m 0755 /tmp/uv-aarch64-unknown-linux-gnu/uv /usr/local/bin/uv; \
    install -m 0755 /tmp/uv-aarch64-unknown-linux-gnu/uvx /usr/local/bin/uvx; \
    rm -rf /tmp/uv.tar.gz /tmp/uv-aarch64-unknown-linux-gnu; \
    uv --version

# Google Workspace CLI (#912) — Rust single binary invoked by the psd-workspace
# skill. ARM64 matches AgentCore runtime. run.js/common.js authenticate each
# call by exporting the per-user OAuth access token as GOOGLE_WORKSPACE_CLI_TOKEN
# (gws ignores GOOGLE_ACCESS_TOKEN — see common.js execGws).
#
# The real binary is installed as /usr/local/bin/gws.real and a refuse-by-default
# wrapper is installed as /usr/local/bin/gws. Every `gws` from the agent's exec
# tool resolves the wrapper first; run.js reaches gws.real directly. See
# bin/gws-wrapper.sh for rationale (incident: 2026-07-01 — bare `gws chat spaces
# list` → 401 → wrong "no credentials" answer + Phase 1 gate-bypass surface).
#
# Pinned version + SHA256 come from the official release's .sha256 sidecar.
# When bumping, run:
#   curl -sL "https://github.com/googleworkspace/cli/releases/download/v<VER>/google-workspace-cli-aarch64-unknown-linux-gnu.tar.gz.sha256"
# and paste the hex digest into GWS_SHA256 below.
ARG GWS_VERSION=0.22.5
ARG GWS_SHA256=94490295d9580e1e88574e715a0a162991747d12d62f8c7b8dcc8268b6c1cea0
# COPY --chmod so the wrapper mode lands in one layer (layer count is
# load-bearing for AgentCore's Firecracker snapshotter — see gh install below).
COPY --chmod=755 bin/gws-wrapper.sh /usr/local/bin/gws
# Install the real gws binary as /usr/local/bin/gws.real. The final
# `gws --version` verifies the wrapper delegates introspection to it.
RUN set -eux; \
    curl -fsSL -o /tmp/gws.tar.gz \
      "https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-aarch64-unknown-linux-gnu.tar.gz"; \
    echo "${GWS_SHA256}  /tmp/gws.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gws.tar.gz -C /tmp --strip-components=0 ./gws; \
    mv /tmp/gws /usr/local/bin/gws.real; \
    rm /tmp/gws.tar.gz; \
    chmod +x /usr/local/bin/gws.real; \
    /usr/local/bin/gws.real --version; \
    /usr/local/bin/gws --version

# GitHub CLI (#965 follow-on) — single Go binary so the agent can read PRs,
# issues, and run gh-api calls without us shipping a custom skill. ARM64
# matches AgentCore runtime.
#
# Pinned version + SHA256. When bumping, run:
#   curl -fsSL "https://github.com/cli/cli/releases/download/v<VER>/gh_<VER>_linux_arm64.tar.gz" \
#     | shasum -a 256
# and paste the hex digest into GH_SHA256 below.
ARG GH_VERSION=2.92.0
ARG GH_SHA256=c2248526dd0160c08d3fccca2332c3c1a07c15a78b23978e77735f1b5a18cfee
# Install the destructive-operation wrapper as /usr/local/bin/gh. Every
# `gh` invocation from skills, the agent's exec tool, or any subprocess
# goes through this script first. See bin/gh-wrapper.sh for the
# blocklist and rationale (incident: 2026-05-19, PR #995
# autonomously merged by the agent).
#
# COPY is BuildKit's --chmod variant so the mode lands in one layer
# with no follow-up chmod RUN — layer count is load-bearing for
# AgentCore's Firecracker snapshotter (54+ layers consistently fail
# overlay mount; see 2026-05-18 / 2026-05-19 incidents).
COPY --chmod=755 bin/gh-wrapper.sh /usr/local/bin/gh

# Install real gh binary as /usr/local/bin/gh.real (the wrapper above
# delegates to it). Combined into a single RUN so we don't burn an
# extra layer on the wrapper verification step.
RUN set -eux; \
    curl -fsSL -o /tmp/gh.tar.gz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.tar.gz"; \
    echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    mv "/tmp/gh_${GH_VERSION}_linux_arm64/bin/gh" /usr/local/bin/gh.real; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_arm64"; \
    chmod +x /usr/local/bin/gh.real; \
    /usr/local/bin/gh.real --version; \
    /usr/local/bin/gh --version

# Install the bedrock-agentcore SDK in a virtual environment (avoids
# --break-system-packages). Provenance is confirmed: this IS the official AWS
# SDK (github.com/aws/bedrock-agentcore-sdk-python, author "AWS"), so the
# earlier name-squat concern is disproven. It is hash-pinned to 1.15.1 via
# requirements-agentcore.txt and installed with --require-hashes — the full
# transitive closure must be present and hashed, so pip aborts the build on any
# tampering or mismatch (the image build IS the supply-chain test). API
# compatibility with agentcore_wrapper.py is verified for 1.15.1 (see the
# header in requirements-agentcore.txt). Regenerate the hashes after a bump.
COPY requirements-agentcore.txt /tmp/requirements-agentcore.txt
RUN python3 -m venv /opt/agentcore-venv && \
    /opt/agentcore-venv/bin/pip install --no-cache-dir --require-hashes \
      -r /tmp/requirements-agentcore.txt && \
    rm -f /tmp/requirements-agentcore.txt
# matplotlib was added here for chat-chart's local engine, but it triggers
# AgentCore's overlay-mount snapshotter to fail at microVM boot
# (2026-05-18 — every microVM dies with "Failed to mount overlay: No such
# file or directory"). Until we find a chart renderer that doesn't trip
# the snapshotter, chat-chart runs in QuickChart-only mode (no local
# engine). Re-add matplotlib here AND the chat-chart npm install below
# AND remove the lazy require + engine-auto override in
# skills/chat-chart/run.js to bring local back.

# Add venv to PATH so python3 uses the venv by default
ENV PATH="/opt/agentcore-venv/bin:$PATH"

# Create workspace and config directories
RUN mkdir -p /home/node/.openclaw/memory

# Copy PSD configuration files
# openclaw.json tuning notes (keep here — JSON can't carry comments and
# OpenClaw's config validator rejects "//" pseudo-keys):
#
#   providers.amazon-bedrock — points at Bedrock Mantle, AWS's
#   OpenAI-compatible endpoint for Bedrock. We used to run a local
#   bedrock-proxy.js that translated OpenAI → Converse; Mantle removes that
#   translation layer entirely. Result: we own no per-model format adapter
#   code; any Bedrock model works by changing the `id` below.
#
#   plugins.entries.active-memory — blocking memory sub-agent that runs before
#   every main reply, shares the inherited session model, and its failure
#   cascades to the main reply as `surface_error`. Config rationale:
#     queryMode=message     — smallest workload (only the latest user msg)
#     promptStyle=strict    — recommended pairing for message mode
#     timeoutMs=30000       — stock 15000 timed out on trivial inputs; 30s
#                             gives Bedrock cold-start headroom without
#                             letting a truly stuck sub-agent hold the turn
#                             hostage
#     maxSummaryChars=220   — keep the injected snippet tiny
#     persistTranscripts=false — we don't need per-sub-agent transcripts
#
#   TODO: give the sub-agent a dedicated fast model (Haiku/Nova) via
#   config.model — requires adding a second model to bedrock-proxy. Until
#   then the sub-agent adds ~5-10s to every turn's wall-clock latency.
COPY openclaw.json /home/node/.openclaw/openclaw.json
# OpenClaw auto-injects SOUL.md as the system prompt every turn.
# NOTE: Do NOT put HTML comments or TODO notes in this file — they are
# visible to the LLM. Keep roadmap notes here in the Dockerfile instead.
# TODO(phase-2): Add Google Calendar and Gmail read-only tool access to the agent.
#
# Tier-1 enforcement: SOUL.md alone is auto-loaded, but the rules in
# psd-rules SKILL.md are NOT auto-injected by OpenClaw — the model only
# sees a Tier-2 catalog stub for any skill it has not explicitly loaded.
# That meant the "non-negotiable" rules were never actually present in
# the system prompt and the agent ignored them (observed 2026-05-03).
# At build time we strip psd-rules' YAML frontmatter and append the body
# to SOUL.md so the rules ARE in the system prompt every turn. The
# canonical edit point stays `skills/psd-rules/SKILL.md`.
COPY SOUL.md /tmp/SOUL.preamble.md
COPY skills/psd-rules/SKILL.md /tmp/psd-rules.SKILL.md
RUN awk 'BEGIN{f=0} /^---[[:space:]]*$/{f++; next} f>=2{print}' /tmp/psd-rules.SKILL.md > /tmp/psd-rules.body.md && \
    cat /tmp/SOUL.preamble.md > /home/node/.openclaw/SOUL.md && \
    printf '\n\n---\n\n# Operating Rules (from psd-rules)\n\n_The following rules are concatenated from `skills/psd-rules/SKILL.md` at container build time so they are guaranteed to appear in every turn\xe2\x80\x99s system prompt. Edit them in that file, not here._\n\n' >> /home/node/.openclaw/SOUL.md && \
    cat /tmp/psd-rules.body.md >> /home/node/.openclaw/SOUL.md && \
    rm -f /tmp/SOUL.preamble.md /tmp/psd-rules.SKILL.md /tmp/psd-rules.body.md
# OpenClaw also auto-loads IDENTITY.md, USER.md, MEMORY.md (and AGENTS.md,
# TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md) when present. We seed empty stubs so
# every brand-new user workspace boots with the same scaffolding; the agent
# fills them in as it learns. Per-user content overrides these on next pull
# from S3 (workspace_sync). Files agent already populated in S3 will replace
# these defaults at startup.
COPY IDENTITY.md /home/node/.openclaw/IDENTITY.md
COPY USER.md /home/node/.openclaw/USER.md
COPY MEMORY.md /home/node/.openclaw/MEMORY.md
# Install OpenClaw skills under /opt/psd-skills (NOT /home/node/.openclaw/).
# Putting image-bundled skills outside the workspace path is structural —
# `workspace_sync.py` only round-trips /home/node/.openclaw/, so paths under
# /opt/ are physically unreachable to S3 sync. Earlier we kept skills under
# the workspace path and protected them with a `_SKIP_RELATIVE_PREFIXES`
# allow-list in workspace_sync; that allow-list silently broke when new
# skills were added (PR #934 — psd-image-gen and psd-freshservice were
# missing entries, so the agent's runtime edits were synced to S3 and
# restored on every cold-start, defeating two image rebuilds in a row).
# Path separation closes that bug class permanently — it is no longer
# possible for workspace state to override an image-bundled skill, no
# allow-list maintenance burden.
#
# Loaded via openclaw.json skills.load.extraDirs. Install dependencies at
# build time so the agent container starts fast.
COPY skills /opt/psd-skills
RUN cd /opt/psd-skills/psd-schedules && npm install --omit=dev --no-audit --no-fund
RUN cd /opt/psd-skills/psd-credentials && npm install --omit=dev --no-audit --no-fund
RUN cd /opt/psd-skills/psd-skills-meta && npm install --omit=dev --no-audit --no-fund
RUN cd /opt/psd-skills/psd-workspace && npm install --omit=dev --no-audit --no-fund
RUN cd /opt/psd-skills/psd-image-gen && npm install --omit=dev --no-audit --no-fund
RUN cd /opt/psd-skills/psd-failure-report && npm install --omit=dev --no-audit --no-fund
RUN cd /opt/psd-skills/psd-email-triage && npm install --omit=dev --no-audit --no-fund
# chat-card has zero npm deps. chat-chart's npm install is paired with the
# matplotlib install above — both stay disabled until we figure out the
# AgentCore overlay-mount failure. With both off the image boots cleanly
# and chat-chart works in QuickChart mode (lazy require in run.js skips
# the AWS SDK load).
# psd-email-triage (Phase 1 email triage) has three @aws-sdk/* deps for
# DynamoDB + EventBridge Scheduler; the npm install adds one layer (we
# were at 49, target 50 — well under the 54-layer Firecracker ceiling
# from the 2026-05-18 incident).
# psd-data has zero npm install of its own. Its common.js require()s
# `@aws-sdk/client-secrets-manager` from psd-workspace's already-installed
# tree via an absolute path. No symlink, no duplicate install — keeps the
# image file-count identical to a no-psd-data build.
# psd-freshservice has zero npm dependencies (native fetch + child_process only).
# psd-brand-guidelines has zero npm dependencies (config + static assets only).
# psd-github has zero npm dependencies (wraps /usr/local/bin/gh).

# Upstream gws-* skills (#912) — per-API SKILL.md guidance for Gmail, Drive,
# Docs, Sheets, Slides, Forms, Tasks, Calendar, Chat, Meet, Contacts, etc.
# Pinned to the same tag as the gws binary above so skill instructions never
# drift from the CLI surface actually installed.
#
# git is required for the shallow clone. apt-get already added
# ca-certificates+curl above; git is not in the base image.
RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/* && \
    git clone --depth 1 --branch "v${GWS_VERSION}" \
      https://github.com/googleworkspace/cli /tmp/gws-repo && \
    cp -r /tmp/gws-repo/skills/gws-* /opt/psd-skills/ && \
    rm -rf /tmp/gws-repo && \
    apt-get purge -y git && apt-get autoremove -y

# Defense-in-depth: lock /opt/psd-skills to root-owned and read-only AFTER
# all installs complete. The container runs as the `node` user, so root
# ownership plus `a-w` means the agent process literally cannot edit a
# bundled skill (EACCES on write/chmod attempts). Combined with the path
# separation above, this is belt-and-suspenders against the regression
# observed 2026-05-03. User-authored draft skills go through
# psd-skills-meta and are uploaded to S3 directly — no local-FS write
# path is needed for legitimate work.
RUN chown -R root:root /opt/psd-skills && chmod -R a-w /opt/psd-skills

# Defense-in-depth: disable OpenClaw's cron subsystem via both config
# (cron.enabled: false in openclaw.json) and env var (OPENCLAW_SKIP_CRON=1)
# per the official docs. Heartbeat is disabled via
# agents.defaults.heartbeat.every: "0m" in openclaw.json (no env var exists).
# The psd-schedules skill is the only scheduling surface in this deployment.
ENV OPENCLAW_SKIP_CRON=1
# Application Python lives in /app. The bundle covers:
#   harness_adapter.py      — OpenClaw WebSocket bridge with empty-turn rescue
#   agent_failures.py       — RDS Data API failure logger
#   agentcore_wrapper.py    — AgentCore HTTP entrypoint
#   workspace_sync.py       — S3 ↔ /home/node/.openclaw sync
#   mantle_proxy.py         — local proxy to Bedrock Mantle with retry/rescue
#   chat_format.py          — Markdown→Google Chat formatter + envelope splitter
# Copied as one layer (with the .dockerignore preventing __pycache__,
# *.pyc, test_*.py, *.test.ts from leaking in) because AgentCore's
# Firecracker snapshotter consistently fails overlay mount at 54+
# layers (2026-05-18 incident). Folding six COPYs into one keeps us
# safely under that ceiling.
COPY *.py /app/

# Container OS clock is UTC. The wrapper reads the user's local time via
# zoneinfo (requires the tzdata package installed above). TZ env var is set
# for any process that reads it directly — not used by agentcore_wrapper
# which passes the IANA name explicitly to zoneinfo.
ENV TZ=America/Los_Angeles

# Set ownership for the node user (OpenClaw runs as node)
RUN chown -R node:node /home/node/.openclaw /app

# Switch back to the non-root user
USER node

# AgentCore invokes the container on port 8080
EXPOSE 8080

# The entrypoint starts the AgentCore wrapper, which manages OpenClaw internally
CMD ["python3", "/app/agentcore_wrapper.py"]
