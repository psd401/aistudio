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
# TODO: Pin to digest (@sha256:...) once a stable release is available.
FROM ghcr.io/openclaw/openclaw:latest

# Switch to root for installations
USER root

# Pin versions for supply-chain safety. Update these as needed.
ARG BUN_VERSION=1.2.12
ARG UV_VERSION=0.7.9
ARG BEDROCK_AGENTCORE_VERSION=1.0.0

# Install bun (JS/TS runtime) and uv (Python package manager)
# Note: curl-pipe-bash is the official install method for bun/uv.
# Pinned versions mitigate supply-chain risk.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh && \
    ln -s /root/.local/bin/uv /usr/local/bin/uv

# Install Python 3.12 and pip for the AgentCore wrapper
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Install the bedrock-agentcore SDK (pinned version)
RUN pip3 install --no-cache-dir --break-system-packages "bedrock-agentcore==${BEDROCK_AGENTCORE_VERSION}"

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
