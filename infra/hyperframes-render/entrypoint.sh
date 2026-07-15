#!/bin/sh
# Lambda container entrypoint for hyperframes-render.
#
# 1. Export PRODUCER_HEADLESS_SHELL_PATH from the path baked in at build time so
#    the hyperframes engine uses BeginFrame deterministic capture.
# 2. Start the AWS Lambda Runtime Interface Client (aws-lambda-ric). Locally
#    (no AWS_LAMBDA_RUNTIME_API) wrap it in the Runtime Interface Emulator so a
#    plain `docker run` exposes the invoke endpoint on :8080. In real Lambda the
#    RIC talks to the runtime API directly.
set -e

if [ -f /opt/chrome-headless-shell-path ]; then
  PRODUCER_HEADLESS_SHELL_PATH="$(cat /opt/chrome-headless-shell-path)"
  export PRODUCER_HEADLESS_SHELL_PATH
fi

RIC=/var/task/node_modules/.bin/aws-lambda-ric

if [ -z "${AWS_LAMBDA_RUNTIME_API}" ]; then
  exec /usr/local/bin/aws-lambda-rie "$RIC" "$@"
else
  exec "$RIC" "$@"
fi
