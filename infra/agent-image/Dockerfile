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
# Downloads are verified via SHA256 checksums to prevent MITM/CDN compromise.
# Checksums must be updated when bumping versions above.
ARG BUN_SHA256="a]PLACEHOLDER — run: curl -fsSL https://bun.sh/install | sha256sum"
ARG UV_SHA256="PLACEHOLDER — run: curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sha256sum"

RUN curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh && \
    echo "${BUN_SHA256}  /tmp/bun-install.sh" | sha256sum -c - && \
    bash /tmp/bun-install.sh "bun-v${BUN_VERSION}" && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    rm /tmp/bun-install.sh && \
    curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" -o /tmp/uv-install.sh && \
    echo "${UV_SHA256}  /tmp/uv-install.sh" | sha256sum -c - && \
    bash /tmp/uv-install.sh && \
    ln -s /root/.local/bin/uv /usr/local/bin/uv && \
    rm /tmp/uv-install.sh

# Install Python and pip for the AgentCore wrapper.
# The exact Python version depends on the base image's distro packages.
# Verify with: docker run --rm psd-agent-base:latest python3 --version
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Install the bedrock-agentcore SDK in a virtual environment (avoids --break-system-packages)
# BLOCKER(prod): Verify the "bedrock-agentcore" PyPI package is the official AWS SDK
# (not an unrelated name-squatted package). The SDK is pre-GA as of this PR — confirm
# the package name on https://pypi.org/project/bedrock-agentcore/ before production use.
RUN python3 -m venv /opt/agentcore-venv && \
    /opt/agentcore-venv/bin/pip install --no-cache-dir "bedrock-agentcore==${BEDROCK_AGENTCORE_VERSION}"

# Add venv to PATH so python3 uses the venv by default
ENV PATH="/opt/agentcore-venv/bin:$PATH"

# Create workspace and config directories
RUN mkdir -p /home/node/.openclaw/memory

# Copy PSD configuration files
COPY openclaw.json /home/node/.openclaw/openclaw.json
COPY psd-system-prompt.md /home/node/.openclaw/psd-system-prompt.md
COPY harness_adapter.py /app/harness_adapter.py
COPY agentcore_wrapper.py /app/agentcore_wrapper.py

# Set ownership for the node user (OpenClaw runs as node)
RUN chown -R node:node /home/node/.openclaw /app

# Switch back to the non-root user
USER node

# AgentCore invokes the container on port 8080
EXPOSE 8080

# The entrypoint starts the AgentCore wrapper, which manages OpenClaw internally
CMD ["python3", "/app/agentcore_wrapper.py"]
