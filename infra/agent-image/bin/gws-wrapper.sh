#!/usr/bin/env bash
# gws-wrapper.sh — refuse-by-default wrapper around the Google Workspace CLI.
#
# Installed at /usr/local/bin/gws inside the agent container; the real binary
# lives at /usr/local/bin/gws.real. Every `gws` invocation from the agent's
# `exec` tool or any subprocess resolves this wrapper first (PATH lookup).
#
# Rationale: the ONLY sanctioned path to Google Workspace is the psd-workspace
# skill —
#     node /opt/psd-skills/psd-workspace/run.js --user <email> \
#          --command "<gws subcommand> ..." [--scope user|agent]
# run.js/common.js are the only place that (a) injects the per-user OAuth
# access token and (b) enforces the Phase 1 hard gates (no send, no delete, no
# permission changes) plus marker/audit injection. run.js reaches the real
# binary directly at /usr/local/bin/gws.real, so it is unaffected by this
# wrapper.
#
# A BARE `gws ...` from the model has NO token (→ 401 "No credentials
# provided") AND bypasses every Phase 1 gate. On 2026-07-01 the agent ran a
# bare `gws chat spaces list`, got the 401, and told the user "the agent
# account isn't set up with Google Workspace credentials" — a wrong answer
# from a self-inflicted auth failure, and a live gate-bypass surface.
#
# This wrapper is the structural backstop. The companion textual rules live in
# skills/psd-rules/SKILL.md (Rule 9) and skills/psd-workspace/SKILL.md.
#
# Residual risk (documented, not closed here): the container's exec tool could
# in principle invoke /usr/local/bin/gws.real directly. Closing that requires
# scoping the AgentCore role away from the workspace secrets and/or removing
# the raw exec tool from the OpenClaw profile — tracked separately.

set -uo pipefail

REAL_GWS="/usr/local/bin/gws.real"

# If the real binary somehow isn't present, loud-fail rather than silently
# degrade to an unwrapped gws on PATH.
if [ ! -x "$REAL_GWS" ]; then
  echo "gws-wrapper: real gws binary missing at $REAL_GWS — refusing to run." >&2
  exit 127
fi

# Identify the first positional (non-flag) token — the gws subcommand.
sub=""
for arg in "$@"; do
  case "$arg" in
    -*) : ;;            # flag — skip
    *)  sub="$arg"; break ;;
  esac
done

# Allow auth-free introspection straight through to the real binary so the
# model can still discover the command surface (psd-workspace SKILL.md tells
# it to "run `gws schema <method>` first"). These touch no user data.
case "${1:-}" in
  --version|-V|--help|-h)
    exec "$REAL_GWS" "$@"
    ;;
esac
case "$sub" in
  schema|help|version)
    exec "$REAL_GWS" "$@"
    ;;
esac

# Everything else touches user data and MUST go through the skill.
cat >&2 <<'EOF'
gws-wrapper: direct `gws` calls are disabled inside the agent.

All Google Workspace access must go through the psd-workspace skill, which
injects the OAuth token and enforces the Phase 1 safety gates:

  node /opt/psd-skills/psd-workspace/run.js --user <caller-email> \
       --command "<gws subcommand> ..." [--scope user|agent]

A bare `gws` has no credentials (it will 401) and bypasses the send/delete/
permission-change gates. If you were about to report "no Workspace
credentials are set up," that conclusion is wrong — route through run.js.
EOF
exit 13
