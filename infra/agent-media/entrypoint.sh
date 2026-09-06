#!/bin/sh
# Lambda container entrypoint for agent-media.
#
# Start the AWS Lambda Runtime Interface Client (aws-lambda-ric). Locally (no
# AWS_LAMBDA_RUNTIME_API) wrap it in the Runtime Interface Emulator so a plain
# `docker run` exposes the invoke endpoint on :8080 for smoke testing. In real
# Lambda the RIC talks to the runtime API directly and the RIE is inert.
#
# No PRODUCER_HEADLESS_SHELL_PATH export here, unlike hyperframes-render: this
# image uses Debian's chromium directly for print-to-PDF and installs no
# chrome-headless-shell, because nothing here needs BeginFrame capture.
set -e

RIC=/var/task/node_modules/.bin/aws-lambda-ric

if [ -z "${AWS_LAMBDA_RUNTIME_API}" ]; then
  exec /usr/local/bin/aws-lambda-rie "$RIC" "$@"
else
  exec "$RIC" "$@"
fi
