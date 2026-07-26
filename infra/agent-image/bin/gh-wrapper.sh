#!/usr/bin/env bash
# Model-facing compatibility entrypoint for GitHub operations.
#
# There is no local GitHub CLI binary or PAT in this image. The Node helper forwards argv
# plus the opaque router-signed invocation context to the trusted web broker.
# The broker independently applies a named-operation allowlist and executes gh
# with the signed owner's credential outside the model security boundary.

set -uo pipefail

BROKER_HELPER="/opt/psd-skills/_shared/github-cli.js"
if [ ! -f "$BROKER_HELPER" ]; then
  echo "gh-wrapper: trusted GitHub broker helper is missing — refusing." >&2
  exit 127
fi
exec node "$BROKER_HELPER" "$@"
