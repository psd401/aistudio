#!/usr/bin/env bash
# gws-wrapper.sh — refuse-by-default wrapper around the Google Workspace CLI.
#
# Installed at /usr/local/bin/gws inside the model-facing agent container.
# There is deliberately no real Workspace CLI in this image.
#
# Rationale: the ONLY sanctioned path to Google Workspace is the psd-workspace
# skill —
#     node /opt/psd-skills/psd-workspace/run.js --user <email> \
#          --command "<gws subcommand> ..." [--scope user|agent]
# run.js submits an argv array plus the router-signed invocation context to the
# trusted web broker. The broker derives the owner, obtains the OAuth token,
# applies its own allowlist, and runs gws outside the model security boundary.
#
# A BARE `gws ...` from the model has NO token (→ 401 "No credentials
# provided") AND bypasses every Phase 1 gate. On 2026-07-01 the agent ran a
# bare `gws chat spaces list`, got the 401, and told the user "the agent
# account isn't set up with Google Workspace credentials" — a wrong answer
# from a self-inflicted auth failure, and a live gate-bypass surface.
#
# This wrapper exists only to provide an actionable error for old prompts.

set -uo pipefail

cat >&2 <<'EOF'
gws-wrapper: direct `gws` calls are disabled inside the agent.

All Google Workspace access must go through the psd-workspace skill, which
uses the signed invocation context and enforces the Phase 1 safety gates:

  node /opt/psd-skills/psd-workspace/run.js --user <caller-email> \
       --command "<gws subcommand> ..." [--scope user|agent]

The model-facing image contains no Workspace CLI or OAuth credential.
EOF
exit 13
