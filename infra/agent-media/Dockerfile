# agent-media — container-image Lambda giving the agent the three media
# capabilities it kept having to refuse (issue #1738):
#
#   html-to-pdf  headless Chromium print-to-PDF, honouring @page CSS
#                (nashs, 2026-09-01: "save this 8.5x11 sign as a PDF" — the
#                 PyMuPDF fallback produced a garbled 400x600pt page)
#   media        ffmpeg transcode + ffprobe inspection
#                (kinneyk, 2026-09-01: a .mov to verify for Facebook/Instagram)
#   transcribe   Amazon Transcribe over audio in the owner's workspace
#                (demontek, 2026-09-03: an .m4a to turn into a printable script)
#
# Chromium and FFmpeg live HERE, never in the agent image: the AgentCore
# Firecracker overlay-mount snapshotter cannot carry that native stack, and the
# agent image sits near its 54-layer ceiling (see infra/agent-image/Dockerfile).
# Lambda's 10 GB image limit is ample.
#
# SEPARATE from hyperframes-render deliberately, despite the overlapping tool
# set. That function's role may write ONLY to public-images/; this one reads and
# writes the owner's PRIVATE workspace prefix, because a scanned IEP or a staff
# recording must never land in a public-by-link bucket. Merging them would widen
# a production role to avoid a second image — the wrong trade.
FROM node:22-bookworm-slim

# Runtime deps: chromium + the shared libs it needs, fonts so a rendered page
# looks like the page its author saw, and the build deps for aws-lambda-ric's
# native addon. No @puppeteer/browsers here — unlike hyperframes, print-to-PDF
# needs no BeginFrame-deterministic capture, so Debian's chromium is enough and
# the image stays smaller.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip xz-utils chromium \
    libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
    libxdamage1 libxrandr2 libcups2 libasound2 libpangocairo-1.0-0 \
    libxshmfence1 libgtk-3-0 \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-noto-core \
    fonts-noto-extra fonts-noto-ui-core fonts-freefont-ttf fonts-dejavu-core \
    fontconfig \
    g++ make cmake libcurl4-openssl-dev python3 \
    && rm -rf /var/lib/apt/lists/* && apt-get clean && fc-cache -fv

ENV CHROMIUM_PATH=/usr/bin/chromium
ENV CONTAINER=true

# Self-contained ffmpeg/ffprobe, copied from a registry image pinned BY DIGEST.
# Two hard-won reasons, both carried over from infra/hyperframes-render:
#   1. Debian's ffmpeg dynamically loads 40+ shared libraries and its preflight
#      FAILS inside the Lambda sandbox ("FFmpeg cannot start"), while a fully
#      static build starts cleanly.
#   2. BtbN's autobuild tags 404 after ~2-3 weeks — that publisher keeps no
#      permanent version tags, so any autobuild pin rots on a timer and breaks
#      the deploy. A registry digest cannot expire.
# mwader/static-ffmpeg is third-party and single-maintainer; the digest pin is
# what makes that acceptable — the exact bytes verified here are the only bytes
# a later build can copy.
COPY --from=mwader/static-ffmpeg:7.1.1-amd64@sha256:6769881cc02c80d33e387750a8e144d162adfab2775e934dd97899261dda3a0c \
    /ffmpeg /ffprobe /opt/ffmpeg/
# Prove both binaries execute in THIS base image rather than trusting the copy —
# a static binary from a musl image running on Debian is exactly the combination
# worth verifying at build time.
RUN /opt/ffmpeg/ffmpeg -version | head -1 && /opt/ffmpeg/ffprobe -version | head -1
ENV FFMPEG_PATH=/opt/ffmpeg/ffmpeg
ENV FFPROBE_PATH=/opt/ffmpeg/ffprobe

# Prove Chromium can actually produce a PDF at build time. A missing shared
# library or a rejected sandbox flag otherwise surfaces as a runtime failure on
# a real user's document, long after the image shipped.
RUN printf '<!doctype html><title>probe</title><p>probe</p>' > /tmp/probe.html \
    && /usr/bin/chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
       --no-pdf-header-footer --print-to-pdf=/tmp/probe.pdf /tmp/probe.html \
    && head -c 5 /tmp/probe.pdf | grep -q '%PDF-' \
    && rm -f /tmp/probe.html /tmp/probe.pdf \
    && echo "chromium print-to-pdf OK"

WORKDIR /var/task
COPY agent-media/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY agent-media/handler.js ./
# handler.js resolves ../validated-fs.cjs to /var/validated-fs.cjs at runtime.
# Built from the infra/ context so this is the canonical shared implementation,
# not a duplicate that can drift from the repository security wrapper.
COPY validated-fs.cjs /var/validated-fs.cjs
COPY agent-media/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Runtime Interface Emulator — local `docker run` smoke testing only. Real
# Lambda sets AWS_LAMBDA_RUNTIME_API, so the entrypoint bypasses it there.
# Pinned to a release, not `latest`, so rebuilds don't silently bake a different
# binary; the x86_64 asset matches the Architecture.X86_64 function.
ARG AWS_LAMBDA_RIE_VERSION=v1.35
ADD https://github.com/aws/aws-lambda-runtime-interface-emulator/releases/download/${AWS_LAMBDA_RIE_VERSION}/aws-lambda-rie-x86_64 /usr/local/bin/aws-lambda-rie
RUN chmod +x /usr/local/bin/aws-lambda-rie

ENTRYPOINT ["/entrypoint.sh"]
CMD ["handler.handler"]
