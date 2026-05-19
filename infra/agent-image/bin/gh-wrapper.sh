#!/usr/bin/env bash
# gh-wrapper.sh — blocklist wrapper around the real GitHub CLI.
#
# Installed at /usr/local/bin/gh inside the agent container; the real
# binary lives at /usr/local/bin/gh.real. Every `gh` invocation from a
# skill, the agent's `exec` tool, or anything else inside the container
# goes through here first.
#
# Rationale: gh inside the container is authenticated as the calling
# user (per-user OAuth, hydrated by agent-startup.sh from Secrets
# Manager) and would otherwise have full repo admin rights. On
# 2026-05-19 the agent autonomously created PR #995 and merged it
# itself using `gh pr merge`, with no human in the loop and no audit
# distinction from a real human merge. That's an unacceptable
# governance posture: code changes that touch production must require
# explicit human action.
#
# This wrapper is the structural backstop. The companion textual rule
# lives in infra/agent-image/skills/psd-rules/SKILL.md.
#
# Blocked operations (exit 2, stderr message):
#   gh pr merge ...
#   gh repo delete ...
#   gh repo edit ...               (changes settings, archives, etc.)
#   gh release delete ...
#   gh api -X DELETE ...
#   gh api -X PUT|POST ... /pulls/*/merge          (raw-API PR merge)
#   gh api -X PUT|POST|PATCH ... /branches/*/protection  (rule bypass)
#
# Explicitly ALLOWED (no change in behaviour):
#   gh pr {create,view,list,diff,checkout,comment,review,...}
#   gh issue {create,view,list,close,reopen,comment,edit,...}   ← closes OK
#   gh repo {view,clone,list,fork,...}
#   gh release {create,view,list,upload,...}
#   gh api GET / POST (when not on the blocked paths above)
#   gh auth ...
#   gh search ...
#   gh workflow / gh run / gh cache / gh ssh-key / gh gist / etc.
#
# Closing issues is intentionally allowed — those are reversible.
# Merging PRs and deleting/editing repo settings are not.
#
# If a future need legitimately requires one of the blocked
# operations, edit this file (and the psd-rules entry). Do not try to
# bypass it from inside the container.

set -uo pipefail

REAL_GH="/usr/local/bin/gh.real"

# If the real binary somehow isn't there, fall back to whichever gh is
# on PATH — but loud-fail so we don't silently degrade to unwrapped gh.
if [ ! -x "$REAL_GH" ]; then
  echo "gh-wrapper: real gh binary missing at $REAL_GH — refusing to run." >&2
  exit 127
fi

refuse() {
  echo "gh-wrapper: blocked '$1' — destructive GitHub operation." >&2
  echo "gh-wrapper: this action requires direct human invocation. If a skill" >&2
  echo "gh-wrapper: needs it, edit infra/agent-image/bin/gh-wrapper.sh in the" >&2
  echo "gh-wrapper: AI Studio repo and ship a new agent image." >&2
  exit 2
}

# Collect non-flag positional tokens so we can identify the subcommand
# chain ("pr merge", "repo delete", ...) regardless of where --json /
# --jq / -R style flags are interleaved.
tokens=()
for arg in "$@"; do
  case "$arg" in
    -*) : ;;     # flag — skip
    *)  tokens+=("$arg") ;;
  esac
done

# Build a head string of the first three positional tokens so we can do
# a single case-match against the high-risk subcommand chains.
head="${tokens[0]:-} ${tokens[1]:-} ${tokens[2]:-}"

case "$head" in
  "pr merge "*|"pr merge")        refuse "gh pr merge" ;;
  "repo delete "*|"repo delete")  refuse "gh repo delete" ;;
  "repo edit "*|"repo edit")      refuse "gh repo edit" ;;
  "release delete "*|"release delete") refuse "gh release delete" ;;
esac

# gh api: enforce method + path policy.
if [ "${tokens[0]:-}" = "api" ]; then
  method=""
  # Find -X / --method anywhere in the original argv.
  i=1
  for arg in "$@"; do
    case "$arg" in
      -X|--method)
        # Method value is the next argv slot. Use indirect lookup.
        next_idx=$((i + 1))
        method=$(eval "echo \${$next_idx:-}")
        ;;
      -X*) method="${arg#-X}" ;;
      --method=*) method="${arg#--method=}" ;;
    esac
    i=$((i + 1))
  done
  # The path is the first positional token starting with `/` or
  # `repos/`. Either form is valid for gh api.
  path=""
  for t in "${tokens[@]}"; do
    case "$t" in
      /*|repos/*) path="$t" ; break ;;
    esac
  done

  # DELETE via raw api covers repo delete, branch delete, release
  # delete, pr close (also rejected above by name), etc.
  if [ "$method" = "DELETE" ]; then
    refuse "gh api -X DELETE $path"
  fi

  # Path-based blocks: raw API PR merge, branch protection bypass.
  case "$path" in
    */pulls/*/merge)
      refuse "gh api ... $path (raw PR merge)" ;;
    */branches/*/protection|*/branches/*/protection/*)
      refuse "gh api ... $path (branch protection)" ;;
  esac
fi

# Allowed — hand off to the real gh.
exec "$REAL_GH" "$@"
