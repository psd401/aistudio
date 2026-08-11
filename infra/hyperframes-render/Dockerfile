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

# Self-contained ffmpeg/ffprobe. The Debian `ffmpeg` package installed above is a
# valid amd64 binary that runs fine under local emulation, but its hyperframes
# preflight FAILS inside the AWS Lambda sandbox — "FFmpeg cannot start / Failed to
# run /usr/bin/ffmpeg -version" (confirmed live on psd-hyperframes-render-dev,
# #1175 follow-up). The Debian build dynamically loads 40+ shared libraries
# (libplacebo, libvulkan, sdl2, GPU/desktop libs, …); that lib-loading is the one
# thing that differs between working emulation and the failing Lambda. A fully
# static build has no such lib-loading step, so it starts cleanly.
# hyperframes uses it via HYPERFRAMES_FFMPEG_PATH / HYPERFRAMES_FFPROBE_PATH below.
#
# Copied from a registry image pinned BY DIGEST, not downloaded from a release
# asset. The previous pin (BtbN autobuild-2026-07-15-14-01) started returning 404
# and broke the deploy: the comment here claimed that tag was immutable, and it is
# not. BtbN keeps only ~2-3 weeks of autobuild releases and publishes NO permanent
# version tags — verified against the GitHub releases API, which lists `latest`
# plus rolling `autobuild-*` and nothing else. Any autobuild pin therefore rots on
# a timer. A registry digest cannot, so this replaces the download + checksum with
# an equivalent-strength content-address that does not expire.
#
# This build also suits the requirement better than BtbN's did. It is configured
# --disable-shared --enable-static with libx264/libx265, so NOTHING is
# dynamically loaded — not even glibc, which was BtbN's one remaining runtime
# dependency. That closes the failure mode this whole block exists for.
#
# Version note: 7.1.1 is the newest 7.1.x this publisher ships, so it is a small
# patch step back from BtbN's n7.1.5 build. Deliberate — staying on the ffmpeg 7
# line that hyperframes was validated against is lower risk than jumping to 8.x
# or 9.x for a deploy fix. Bump with the same digest-pinned form.
#
# Trust note for a future audit: mwader/static-ffmpeg is a third-party,
# single-maintainer image, not an official publisher. The digest pin is what makes
# that acceptable — the exact bytes verified here are the only bytes any later
# build can copy, so the content cannot drift under us even if the tag moves.
# This adds no new availability domain either: the base image above already comes
# from Docker Hub, so a Hub outage or an unauthenticated pull-rate limit would
# have failed this build before this change too.
COPY --from=mwader/static-ffmpeg:7.1.1-amd64@sha256:6769881cc02c80d33e387750a8e144d162adfab2775e934dd97899261dda3a0c \
    /ffmpeg /ffprobe /opt/ffmpeg/
# Prove both binaries actually execute in this base image rather than trusting
# the copy — a static binary from a musl image running on Debian is exactly the
# combination worth verifying at build time.
RUN /opt/ffmpeg/ffmpeg -version | head -1 && /opt/ffmpeg/ffprobe -version | head -1
ENV HYPERFRAMES_FFMPEG_PATH=/opt/ffmpeg/ffmpeg
ENV HYPERFRAMES_FFPROBE_PATH=/opt/ffmpeg/ffprobe

# Lambda handler + its runtime deps (aws-lambda-ric + @aws-sdk/client-s3).
WORKDIR /var/task
COPY hyperframes-render/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY hyperframes-render/handler.js ./
# handler.js resolves ../validated-fs.cjs to /var/validated-fs.cjs at runtime.
# Build from the infra/ context so this is the canonical shared implementation,
# not a duplicate that can drift from the repository security wrapper.
COPY validated-fs.cjs /var/validated-fs.cjs
COPY hyperframes-render/entrypoint.sh /entrypoint.sh
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
