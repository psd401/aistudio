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

# Pin base image version for reproducible builds. Update tag periodically.
# BLOCKER(prod): Pin to digest (@sha256:...) before deploying to production.
# :latest is a supply-chain risk — any upstream change is pulled silently.
# Track: Once OpenClaw publishes a stable semver release, pin to that tag+digest.
FROM ghcr.io/openclaw/openclaw:latest

# Switch to root for installations
USER root

# Pin versions for supply-chain safety. Update these as needed.
ARG BUN_VERSION=1.2.12
ARG UV_VERSION=0.7.9
ARG BEDROCK_AGENTCORE_VERSION=1.0.0

# Install bun (JS/TS runtime) and uv (Python package manager)
# Pinned versions mitigate supply-chain risk. curl-pipe-bash is the official
# install method for both tools.
# BLOCKER(prod): Before production deployment, replace curl-pipe-bash with
# checksum-verified installs. Compute SHA256 of each install script at the
# pinned version and verify before execution:
#   curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh
#   echo "<sha256>  /tmp/bun-install.sh" | sha256sum -c -
#   bash /tmp/bun-install.sh "bun-v${BUN_VERSION}"
# This prevents MITM/CDN compromise of the install scripts.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh && \
    ln -s /root/.local/bin/uv /usr/local/bin/uv

# Install Python and pip for the AgentCore wrapper.
# The exact Python version depends on the base image's distro packages.
# Verify with: docker run --rm psd-agent-base:latest python3 --version
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv tzdata ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Google Workspace CLI (#912) — Rust single binary invoked by the psd-workspace
# skill. ARM64 matches AgentCore runtime. Version pinned; bump by manual review.
# The skill passes OAuth access tokens via the GOOGLE_ACCESS_TOKEN env var.
# SECURITY: GWS_SHA256 must be updated when GWS_VERSION changes. Obtain via:
#   curl -fsSL -o /tmp/gws.tar.gz "https://github.com/googleworkspace/cli/releases/download/v<VERSION>/gws-linux-arm64.tar.gz"
#   sha256sum /tmp/gws.tar.gz
ARG GWS_VERSION=0.9.0
ARG GWS_SHA256="PLACEHOLDER_UPDATE_BEFORE_PROD_DEPLOY"
RUN set -eux; \
    curl -fsSL -o /tmp/gws.tar.gz \
      "https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/gws-linux-arm64.tar.gz"; \
    if [ "${GWS_SHA256}" = "PLACEHOLDER_UPDATE_BEFORE_PROD_DEPLOY" ]; then \
      echo "WARNING: GWS_SHA256 is a placeholder — skipping checksum verification (dev only)"; \
      echo "For production, compute the hash: sha256sum /tmp/gws.tar.gz"; \
    else \
      echo "${GWS_SHA256}  /tmp/gws.tar.gz" | sha256sum -c -; \
    fi; \
    tar -xzf /tmp/gws.tar.gz -C /usr/local/bin gws; \
    rm /tmp/gws.tar.gz; \
    chmod +x /usr/local/bin/gws; \
    gws --version

# Install the bedrock-agentcore SDK in a virtual environment (avoids --break-system-packages)
# BLOCKER(prod): Verify the "bedrock-agentcore" PyPI package is the official AWS SDK
# (not an unrelated name-squatted package). The SDK is pre-GA as of this PR — confirm
# the package name on https://pypi.org/project/bedrock-agentcore/ before production use.
RUN python3 -m venv /opt/agentcore-venv && \
    /opt/agentcore-venv/bin/pip install --no-cache-dir \
      "bedrock-agentcore==${BEDROCK_AGENTCORE_VERSION}" \
      "websocket-client>=1.7.0" \
      "boto3>=1.34.0" \
      "aiohttp>=3.9.0"

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
COPY SOUL.md /home/node/.openclaw/SOUL.md
# OpenClaw also auto-loads IDENTITY.md, USER.md, MEMORY.md (and AGENTS.md,
# TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md) when present. We seed empty stubs so
# every brand-new user workspace boots with the same scaffolding; the agent
# fills them in as it learns. Per-user content overrides these on next pull
# from S3 (workspace_sync). Files agent already populated in S3 will replace
# these defaults at startup.
COPY IDENTITY.md /home/node/.openclaw/IDENTITY.md
COPY USER.md /home/node/.openclaw/USER.md
COPY MEMORY.md /home/node/.openclaw/MEMORY.md
# Install OpenClaw skills — each skill is a directory under
# /home/node/.openclaw/skills/ loaded via openclaw.json skills.load.extraDirs.
# Install dependencies at build time so the agent container starts fast.
COPY skills /home/node/.openclaw/skills
RUN cd /home/node/.openclaw/skills/psd-schedules && npm install --omit=dev --no-audit --no-fund
RUN cd /home/node/.openclaw/skills/psd-credentials && npm install --omit=dev --no-audit --no-fund
RUN cd /home/node/.openclaw/skills/psd-skills-meta && npm install --omit=dev --no-audit --no-fund
RUN cd /home/node/.openclaw/skills/psd-workspace && npm install --omit=dev --no-audit --no-fund

# Defense-in-depth: disable OpenClaw's cron subsystem via both config
# (cron.enabled: false in openclaw.json) and env var (OPENCLAW_SKIP_CRON=1)
# per the official docs. Heartbeat is disabled via
# agents.defaults.heartbeat.every: "0m" in openclaw.json (no env var exists).
# The psd-schedules skill is the only scheduling surface in this deployment.
ENV OPENCLAW_SKIP_CRON=1
COPY harness_adapter.py /app/harness_adapter.py
COPY agentcore_wrapper.py /app/agentcore_wrapper.py
COPY workspace_sync.py /app/workspace_sync.py
COPY mantle_proxy.py /app/mantle_proxy.py

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
