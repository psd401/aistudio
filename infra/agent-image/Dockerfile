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
#   ghcr.io/openclaw/openclaw:2026.7.1
#   index: sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c
#
# Moved from the 2026.7.1-beta.2 PRERELEASE pin to 2026.7.1 STABLE (2026-07-27),
# which is what the prerelease note below asked for. Two reasons:
#   1. It is the release of the same line — it carries openclaw PR #99678
#      ("reconcile is not a function" after auto-compaction, the P1 that
#      aborted the 7/6 Plaud production run) plus the empty-reply and
#      compaction-precheck fixes that motivated the prerelease pin.
#   2. It is REQUIRED by the amazon-bedrock provider bump below. Plugin
#      2026.7.1 is the first release whose prompt-caching allowlist knows
#      `claude-sonnet-5`, and it declares `peerDependencies.openclaw >=2026.7.1`
#      / `compat.pluginApi >=2026.7.1`. A prerelease sorts BELOW its release in
#      semver (2026.7.1-beta.2 < 2026.7.1), so pairing plugin 2026.7.1 with the
#      beta.2 host would violate the plugin's own host contract. Host and
#      plugin move together or not at all.
#
# Rollback targets (previous pins):
#   2026.7.1-beta.2  index sha256:0e5680d7d58d3b6c08afa0fc992f4ad319b5586f60923e1985b7c6f838c535d5
#   2026.6.11        index sha256:3814fb1f62f9cfc5944de088c5817c68c88b5d721feebe36420b666a90a61ce7
#   2026.4.20        index sha256:5db497263e85f266142ed6206644de4e401c5906cce835865981113c11486d64
# Rolling back the host REQUIRES rolling the plugin back to 2026.6.11 in the
# same commit (see the host-contract note above) — at the cost of prompt
# caching, which that plugin cannot do for this model.
#
# DO NOT revert to `:latest` or bump without (a) confirming the workspace
# double-nesting fix by commit ancestry and (b) a clean end-to-end test that
# includes the Morning Brief payload — a trivial "respond OK" prompt masks
# session-completion regressions.
FROM ghcr.io/openclaw/openclaw@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c

# Bind every pushed image to the exact clean AI Studio source revision used to
# build it. The nightly evaluator reads this immutable config label instead of
# attributing a deployed image to whichever commit happens to trigger the run.
ARG AISTUDIO_SOURCE_COMMIT
LABEL org.opencontainers.image.source="https://github.com/psd401/aistudio" \
      org.opencontainers.image.revision="${AISTUDIO_SOURCE_COMMIT}"

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
# gws tag for the upstream gws-* SKILL.md docs clone further down. The gws
# BINARY is no longer installed in this image — #1353 moved gws execution to
# the trusted web broker so the model runtime never holds a Google token — but
# the per-API SKILL.md guidance is still copied in, and its clone needs a
# pinned tag. Declared here with the other version pins so the reference at
# the clone step cannot go out of scope again.
ARG GWS_VERSION=0.22.5

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

# The model-facing image deliberately has no real Google Workspace CLI. The
# psd-workspace skill sends an argv array to the owner-bound web broker, where
# the token and executable live. Keep this refusal shim for old prompts.
COPY --chmod=755 bin/gws-wrapper.sh /usr/local/bin/gws

# The model-facing image contains no real GitHub CLI or PAT. This compatibility
# entrypoint forwards argv to the owner-bound web broker, which re-validates a
# strict operation allowlist before executing the trusted web-tier gh binary.
COPY --chmod=755 bin/gh-wrapper.sh /usr/local/bin/gh

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
#   providers.amazon-bedrock-mantle — points only to the loopback
#   credential-isolating proxy. The proxy attaches a router-signed invocation
#   context and forwards to the trusted web model broker. The model-facing
#   process never receives the provider bearer or its Secrets Manager id.
#   The web broker fixes the upstream endpoint/model, caps request/output size,
#   disables redirects, and derives owner authority solely from the signature.
#   contextWindow is set to the HONEST 200k Converse limit (the prior 1M
#   claim caused a real "Context overflow" abort); contextTokens 180000
#   leaves compaction margin below it. params.cacheRetention "long" +
#   contextPruning cache-ttl are the documented production caching pattern
#   (heartbeat stays 0m: AgentCore microVMs idle out at 15 min, so a 55m
#   cache-warm heartbeat can never fire). Model swaps remain one id string.
#   tools.toolSearch=false (2026-07-08, #1138): toolSearch is an EXPERIMENTAL
#   off-by-default mode we enabled for the GLM-5 token diet; with it every
#   action costs search/describe/call round-trips through a JS sandbox
#   (measured 35 model calls for an 8-API-call task). OpenClaw's docs:
#   "Direct tool exposure is still the right default for small catalogs" —
#   ours is ~30 tools, and Sonnet 5's prompt caching makes the schema prefix
#   cheap. codeMode.timeoutMs is retained (inert unless code-mode returns).
#
#   agents.defaults.memorySearch — embedding provider for semantic search over
#   the agent's local ~/.openclaw/memory/ files. OpenClaw's default provider is
#   "openai", but this container provisions NO OpenAI key (it reaches models
#   only through Bedrock Mantle), so memory indexing fails at runtime with
#   `No API key found for provider "openai"`. We pin provider=bedrock +
#   model=amazon.titan-embed-text-v2:0 (the documented Bedrock embedding
#   default) so indexing works out-of-the-box. `provider: bedrock` is OpenClaw's
#   NATIVE Bedrock provider — distinct from the amazon-bedrock-mantle localhost
#   proxy used for chat — so it calls bedrock-runtime.<region>.amazonaws.com
#   directly via the AWS SDK (no baseUrl/region key in the config). Two runtime
#   dependencies follow from that, both already satisfied by the stack:
#     • Region: the AWS SDK needs AWS_REGION, which AgentCore does NOT inject
#       into the microVM (see agentcore_wrapper.py / workspace_sync.py, which
#       hardcode a `|| us-east-1` fallback for exactly this reason). OpenClaw's
#       vendored binary has no such fallback, so AWS_REGION/AWS_DEFAULT_REGION
#       are set explicitly on the AgentCore Runtime (runtimeEnvVars in
#       agent-platform-stack.ts) so this call can resolve an endpoint.
#     • Auth: standard SigV4 from the AgentCore execution role, scoped to the
#       single Titan embedding model. No bearer credential is present.
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
#
#   Subagents (sessions_spawn) are ENABLED — with a behavioral contract.
#   History (2026-07-07, #1138): they were briefly denied after a subagent's
#   finished work never reached the user (completion announcements land in
#   the OpenClaw session; only an ACTIVE chat turn can post to Google Chat).
#   Product decision (Hagel): the capability is wanted — the failure was the
#   USAGE pattern (main agent ended its turn while children ran). psd-rules
#   Rule 15 now enforces hold-your-turn: spawn freely, but keep the turn
#   open until every subagent reports, then reply. Long waits compose with
#   the async-job promotion (#1147), which keeps the session delivering past
#   the 14-min router ceiling. If silent-completion recurs DESPITE Rule 15,
#   the deny list entries were "sessions_spawn", "subagents" (ids per
#   OpenClaw docs/gateway/config-tools.md group:sessions).
#
#   tools.codeMode.timeoutMs=60000 — code-mode (tool_search_code) VM
#   execution ceiling, raised from the 10s default to the documented max
#   (docs/reference/code-mode.md range 100–60000). At 10s, any skill command
#   slower than ~10s (Plaud digest, large gws call) died with
#   "tool_search_code timed out" BEFORE exec could suspend into the
#   status:"waiting" yield path — observed 2026-07-06 (#1138 follow-up): the
#   agent's exec used yieldMs=60000, so the VM was killed at 10s, 50s before
#   it would have yielded. 60s is a ceiling, not a delay: fast calls return
#   as before. Pair with psd-rules guidance to use SHORT yieldMs (≤10s) so
#   long commands suspend early instead of racing this timeout.
COPY openclaw.json /home/node/.openclaw/openclaw.json
# Build-time config sanity check (post-2026-07-02 config-risk hardening): surface
# any openclaw.json schema/key errors at BUILD time instead of at runtime (a
# rejected config would stop the gateway from starting = an outage). Non-fatal
# for now — until we confirm `config validate` needs no live runtime env, we
# only echo a marker on nonzero so a false-positive can't block the build. Read
# the `[config-validate]` lines in the build log; harden to fatal once trusted.
RUN HOME=/home/node openclaw config validate >/tmp/config-validate.log 2>&1; \
    STATUS=$?; \
    sed 's/^/[config-validate] /' /tmp/config-validate.log; \
    rm -f /tmp/config-validate.log; \
    if [ "$STATUS" -ne 0 ]; then \
      echo "[config-validate] NONZERO EXIT — inspect openclaw.json before deploying"; \
    fi
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
# Skill dependencies. Consolidated into a SINGLE RUN (was 7 separate RUNs) to
# stay well under AgentCore's Firecracker overlay-mount layer ceiling — the base
# image sits at the edge (53 layers) and a 54th layer fails to mount with
# "Failed to mount overlay: No such file or directory" (agent outage 2026-07-02,
# caused by adding the gws-wrapper COPY at 53). Absolute `cd` paths so the chain
# is independent of prior CWD. Keep new skills in this RUN, not new RUNs.
#
# The tail of this RUN also vendors the @openclaw/amazon-bedrock-provider
# plugin: it registers the "bedrock" memory-embedding adapter that
# openclaw.json's memorySearch.provider names. The published OpenClaw base
# image ships with NO bundled extensions (they're an opt-in OPENCLAW_EXTENSIONS
# build arg of the upstream Dockerfile), so memory sync failed every cycle with
# "Unknown memory embedding provider: bedrock" (2026-07-10). It must live under
# /opt (image-owned): ~/.openclaw is runtime-persistent storage that shadows
# anything written there at build time. Loaded via openclaw.json
# plugins.load.paths. Version-pinned to the same OpenClaw release this image
# pins (2026.7.1); npm verifies the registry integrity hash on pack. The
# tarball is self-contained (bundleDependencies: @aws-sdk clients ship inside
# it, with an npm-shrinkwrap.json), so no npm install runs after extraction.
#
# 2026.6.11 -> 2026.7.1 (2026-07-27) RESTORES PROMPT CACHING, which had been
# silently off for every turn since #1384 moved chat to this provider. The
# plugin only emits Bedrock Converse `cachePoint` blocks when
# supportsBedrockPromptCaching() recognizes the model, and 2026.6.11's
# allowlist predates Sonnet 5 — it matches only `-4-`, `claude-fable-5`,
# `claude-3-7-sonnet` and `claude-3-5-haiku`, so `us.anthropic.claude-sonnet-5`
# fell through to `return false`. Its fallback injector (onPayload ->
# injectBedrockCachePoints) could not cover for that either: every path to it
# is gated behind isBedrockAppInferenceProfile(), and ours is a SYSTEM-defined
# profile, not an application-inference-profile ARN. So neither the shared
# runtime nor the plugin ever added a cache point, and `cacheRetention: "long"`
# in openclaw.json had nothing to act on. 2026.7.1 adds `claude-sonnet-5` to
# that allowlist. Do not downgrade this plugin without also removing the
# caching expectation — see check_config_consistency.py, which fails the build
# if the two drift apart again.
RUN cd /opt/psd-skills/psd-schedules && npm install --omit=dev --no-audit --no-fund && \
    cd /opt/psd-skills/psd-credentials && npm install --omit=dev --no-audit --no-fund && \
    cd /opt/psd-skills/psd-skills-meta && npm install --omit=dev --no-audit --no-fund && \
    cd /opt/psd-skills/psd-workspace && npm install --omit=dev --no-audit --no-fund && \
    cd /opt/psd-skills/psd-image-gen && npm install --omit=dev --no-audit --no-fund && \
    cd /opt/psd-skills/psd-html-artifact && npm install --omit=dev --no-audit --no-fund && \
    cd /opt/psd-skills/psd-failure-report && npm install --omit=dev --no-audit --no-fund && \
    cd /opt/psd-skills/psd-email-triage && npm install --omit=dev --no-audit --no-fund && \
    cd /opt/psd-skills/psd-hyperframes && npm install --omit=dev --no-audit --no-fund && \
    mkdir -p /opt/openclaw-plugins && cd /opt/openclaw-plugins && \
    npm pack @openclaw/amazon-bedrock-provider@2026.7.1 && \
    tar -xzf openclaw-amazon-bedrock-provider-2026.7.1.tgz && \
    mv package amazon-bedrock && \
    rm openclaw-amazon-bedrock-provider-2026.7.1.tgz && \
    test -f /opt/openclaw-plugins/amazon-bedrock/openclaw.plugin.json && \
    grep -q "claude-sonnet-5" /opt/openclaw-plugins/amazon-bedrock/dist/bedrock-options.js
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
# psd-hyperframes (#1175) has ONE pure-JS dep (@aws-sdk/client-lambda) and NO
# native renderer deps: Chromium/FFmpeg/Puppeteer live ONLY in the separate
# hyperframes-render Lambda (infra/hyperframes-render/), never in this image —
# the AgentCore Firecracker overlay-mount snapshotter cannot carry that native
# stack (same reason matplotlib/pymupdf4llm were removed). The skill just shells
# an InvokeFunction call. Its npm install joins the SINGLE RUN above, adding NO
# new Docker layer (stays under the Firecracker 54-layer ceiling).
# psd-last30days (#1174) is pure Python (stdlib urllib + xml.etree only) with an
# optional boto3 S3 upload — boto3 is already in /opt/agentcore-venv, so it needs
# NO new pip dependency and NO npm install. It is installed solely by the
# `COPY skills /opt/psd-skills` above (same pattern as the Python psd-pdf-to-markdown
# and psd-tts skills), adding NO Docker layer — keeping the image well under the
# Firecracker overlay-mount layer ceiling that constrains this stage.
# psd-html-artifact (#1245) now ALSO carries axe-core + jsdom (regular deps in its
# package.json) for the shared WCAG 2.2 AA accessibility gate (a11y-audit.js).
# They install via its EXISTING `npm install --omit=dev` line in the single RUN
# above — NO new RUN, NO new Docker layer (jsdom's transitive tree adds file count
# and size, not a layer; the Firecracker ceiling is on layers). The renderer stack
# (Chromium/FFmpeg) is unaffected — the gate runs headless-free over jsdom.
# psd-learning-page (#1245) is pure JS with ZERO npm deps of its own: it composes
# psd-pdf-to-markdown / psd-workspace / psd-tts / psd-hyperframes / psd-atrium via
# child_process, and require()s the shared /opt/psd-skills/psd-html-artifact/
# a11y-audit.js (whose jsdom + axe-core resolve from psd-html-artifact's OWN
# node_modules, installed by line ~402). Installed solely by `COPY skills` above —
# NO npm install, NO new Docker layer.
# psd-sop-creator is pure JS with ZERO npm deps of its own: it composes
# psd-pdf-to-markdown / psd-workspace / psd-atrium via child_process and does its
# own template validation with plain string/regex work. Installed solely by
# `COPY skills` above — NO npm install, NO new RUN, NO new Docker layer, which
# keeps this stage under the Firecracker overlay-mount 54-layer ceiling.
# Its PDF path passes --extract-images to psd-pdf-to-markdown; that flag needs no
# new Python dependency either (pymupdf4llm is already in /opt/agentcore-venv and
# writes images itself), so the consolidated venv RUN above is untouched.
# psd-morning-brief (#1413) is pure JS with ZERO npm deps. It composes brokered
# platform skills and APIs, renders its private Atrium newspaper locally, and is
# installed by `COPY skills` above — NO npm install, NO new RUN, NO new layer.

# Upstream gws-* skills (#912) — per-API SKILL.md guidance for Gmail, Drive,
# Docs, Sheets, Slides, Forms, Tasks, Calendar, Chat, Meet, Contacts, etc.
# Pinned via ARG GWS_VERSION (declared with the other version pins near the top
# of this stage) so the guidance never drifts from the CLI surface the web
# broker actually executes. NOTE: the gws binary itself is no longer installed
# here — #1353 moved execution to the trusted web broker — so this clone is the
# only remaining gws artifact in the image, and it ships documentation only.
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
# The symlink makes `require("../../../validated-fs.cjs")` — which every
# lint-hardened skill resolves to /validated-fs.cjs from /opt/psd-skills/<skill>/ —
# find the copy build-and-push.sh stages into skills/ (shipped by the existing
# COPY above; the image sits at the 53-layer Firecracker ceiling, so a dedicated
# COPY layer is not an option). Appended here rather than a new RUN for the same
# reason. Guarded by tests/unit/agent-image-validated-fs-ship.test.ts.
RUN chown -R root:root /opt/psd-skills && chmod -R a-w /opt/psd-skills \
  && ln -s /opt/psd-skills/validated-fs.cjs /validated-fs.cjs

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

# OpenClaw is explicitly dropped to node by harness_adapter.py. The wrapper
# and local relay remain root so model-launched processes cannot read request
# signing authority under /run/psd-agent-authority.
RUN chown -R node:node /home/node/.openclaw && \
    chown -R root:root /app && \
    chmod -R a-w /app

USER root

# AgentCore invokes the container on port 8080
EXPOSE 8080

# The entrypoint starts the AgentCore wrapper, which manages OpenClaw internally
CMD ["python3", "/app/agentcore_wrapper.py"]
