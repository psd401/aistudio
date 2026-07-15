# hyperframes-render — container-image Lambda that renders a HyperFrames
# HTML/CSS/JS composition to MP4 (headless Chromium + FFmpeg) and uploads to
# the workspace S3 public-images/ prefix. Render half of the psd-hyperframes
# agent skill (issue #1175).
#
# Base + package set are ported verbatim from upstream
# heygen-com/hyperframes packages/cli/src/docker/Dockerfile.render (Apache-2.0)
# — the battle-tested Debian dependency list for a containerized `hyperframes
# render`. We add the AWS Lambda Runtime Interface Client (aws-lambda-ric) so a
# non-AWS base image speaks the Lambda Runtime API, plus the RIE for offline
# `docker run` smoke testing.
#
# Chromium/FFmpeg live HERE, never in the agent image: the AgentCore Firecracker
# overlay-mount snapshotter cannot carry that native stack (see
# infra/agent-image/Dockerfile). Lambda's 10 GB image limit is ample.
FROM node:22-bookworm-slim

# Pin the upstream renderer. Bump deliberately; keep in sync with the version
# the psd-hyperframes SKILL.md documents.
ARG HYPERFRAMES_VERSION=0.7.59

# Runtime deps (ffmpeg + chromium + its shared libs + fonts, from upstream
# Dockerfile.render) AND build deps for aws-lambda-ric's native addon
# (g++/make/cmake/libcurl/python3). unzip is required by @puppeteer/browsers;
# xz-utils by aws-lambda-ric's preinstall, which extracts a .tar.xz (curl) and
# fails on the slim base with "tar (child): xz: Cannot exec" without it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip xz-utils ffmpeg chromium \
    libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
    libxdamage1 libxrandr2 libcups2 libasound2 libpangocairo-1.0-0 \
    libxshmfence1 libgtk-3-0 \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-noto-core \
    fonts-noto-extra fonts-noto-ui-core fonts-freefont-ttf fonts-dejavu-core \
    fontconfig \
    g++ make cmake libcurl4-openssl-dev python3 \
    && rm -rf /var/lib/apt/lists/* && apt-get clean && fc-cache -fv

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CONTAINER=true

# chrome-headless-shell unlocks BeginFrame-based deterministic capture. Lambda
# runs x86_64 (the CDK function pins Architecture.X86_64), so chrome-for-testing's
# linux64 build is correct — upstream notes arm64 has no chrome-for-testing build
# and Debian's rolling chromium SIGTRAPs on arm64 (hyperframes #2039).
RUN npx --yes @puppeteer/browsers install chrome-headless-shell@stable --path /opt/chrome-cache

# Bake the resolved chrome-headless-shell path into a file the entrypoint reads
# into PRODUCER_HEADLESS_SHELL_PATH (the version segment is dynamic, so this
# cannot be a static ENV). Fail the build loudly if the binary is missing rather
# than silently downgrading to non-deterministic screenshot capture.
RUN SHELL_PATH=$(find /opt/chrome-cache -name chrome-headless-shell -type f 2>/dev/null | head -1); \
    if [ -z "$SHELL_PATH" ]; then \
      echo "ERROR: chrome-headless-shell binary not found — the browser install step failed." >&2; \
      exit 1; \
    fi; \
    printf '%s' "$SHELL_PATH" > /opt/chrome-headless-shell-path

# The upstream renderer, pinned.
RUN npm install -g hyperframes@${HYPERFRAMES_VERSION} && hyperframes --version

# Lambda handler + its runtime deps (aws-lambda-ric + @aws-sdk/client-s3).
WORKDIR /var/task
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY handler.js ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Runtime Interface Emulator — used only for local `docker run` smoke testing.
# Real Lambda sets AWS_LAMBDA_RUNTIME_API, so the entrypoint bypasses the RIE in
# production; it is inert there. Pinned to a specific release (not `latest`) so
# rebuilds are reproducible and don't silently bake in a different binary; the
# x86_64 asset matches the Architecture.X86_64 image.
ARG AWS_LAMBDA_RIE_VERSION=v1.35
ADD https://github.com/aws/aws-lambda-runtime-interface-emulator/releases/download/${AWS_LAMBDA_RIE_VERSION}/aws-lambda-rie-x86_64 /usr/local/bin/aws-lambda-rie
RUN chmod +x /usr/local/bin/aws-lambda-rie

ENTRYPOINT ["/entrypoint.sh"]
CMD ["handler.handler"]
