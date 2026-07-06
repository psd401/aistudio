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
#   gh alias set ... / gh alias import ...   (aliases are a blocklist bypass)
#   gh api -X DELETE ...           (method match is case-insensitive)
#   gh api graphql ... mutation ... (GraphQL merge/delete bypass)
#   gh api graphql ... --input ...  (opaque request body; refused outright)
#   gh api -X PATCH|PUT ... /repos/{owner}/{repo}   (raw-API repo edit)
#   gh api ... /pulls/*/merge          (raw-API PR merge; any method)
#   gh api ... /branches/*/protection  (rule bypass; any method)
# Endpoints are recognised whether given as /path, repos/…, or a full
# https://api.github.com/… URL. gh config aliases are stripped on every run.
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

# Path to the real gh binary. Overridable via GH_REAL only so the wrapper's
# blocklist can be exercised against a stub in tests; production is unchanged.
REAL_GH="${GH_REAL:-/usr/local/bin/gh.real}"

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
#
# Flags that consume the *next* argv token as their value must have that
# value skipped too, not just the flag itself — otherwise a value-taking
# flag ahead of the subcommand shifts everything after it by one slot and
# the subcommand chain is misread. E.g. `gh --repo o/r pr merge 1` without
# this would collect tokens=(o/r pr merge 1), so head="o/r pr merge" never
# matches the "pr merge "* refuse pattern, and `gh --repo o/r api -X DELETE
# /repos/o/r` would make tokens[0]="o/r" instead of "api", skipping the
# entire `gh api` policy block below (review: claude[bot] high-priority).
_gh_skip_next=0
tokens=()
for arg in "$@"; do
  if [ "$_gh_skip_next" = "1" ]; then
    _gh_skip_next=0
    continue
  fi
  case "$arg" in
    -R|--repo|--jq|--hostname|--input|-X|--method)
      _gh_skip_next=1
      ;;
    -*) : ;;     # flag — skip (covers attached forms like --repo=o/r)
    *)  tokens+=("$arg") ;;
  esac
done

# Neutralize gh aliases (REV-INFRA-004). This wrapper classifies the literal
# argv, but gh expands aliases *inside* gh.real after we've already decided to
# allow — so `gh alias set m 'pr merge'; gh m 123` would slip a merge past us,
# and `--shell` aliases are an arbitrary-command escape hatch. There is no
# legitimate need for aliases inside the container, so we strip any aliases:
# block from the gh config on every invocation (idempotent) and refuse
# alias set/import below. Reading aliases (alias list) stays allowed.
GH_CFG="${GH_CONFIG_DIR:-$HOME/.config/gh}/config.yml"
if [ -f "$GH_CFG" ] && grep -q '^aliases:' "$GH_CFG"; then
  _gh_tmp="$(mktemp 2>/dev/null || echo '')"
  if [ -n "$_gh_tmp" ]; then
    # Drop the `aliases:` key and its indented children; keep everything else.
    # Blank lines and comments inside the block must not reset `skip` early —
    # otherwise an alias entry following one is left un-stripped (blocklist
    # bypass) (REV-review: gemini-code-assist high-priority).
    awk '
      /^aliases:[[:space:]]*$/ { skip=1; next }
      skip==1 && (/^[[:space:]]/ || /^$/ || /^#/) { next }
      skip==1 { skip=0 }
      { print }
    ' "$GH_CFG" > "$_gh_tmp" && mv "$_gh_tmp" "$GH_CFG"
    rm -f "$_gh_tmp"
  fi
fi

# Build a head string of the first three positional tokens so we can do
# a single case-match against the high-risk subcommand chains.
head="${tokens[0]:-} ${tokens[1]:-} ${tokens[2]:-}"

case "$head" in
  "pr merge "*|"pr merge")        refuse "gh pr merge" ;;
  "repo delete "*|"repo delete")  refuse "gh repo delete" ;;
  "repo edit "*|"repo edit")      refuse "gh repo edit" ;;
  "release delete "*|"release delete") refuse "gh release delete" ;;
  "alias set "*|"alias set")      refuse "gh alias set" ;;
  "alias import "*|"alias import") refuse "gh alias import" ;;
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
  # Normalise the method to upper-case: `gh api -X delete` must be treated the
  # same as `-X DELETE` (REV-COR-316).
  method="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"

  # Block GraphQL mutations wholesale (REV-COR-316, REV-INFRA-003). GraphQL is a
  # single POST endpoint whose semantics live in the body, so path/method rules
  # can't see mergePullRequest / deleteRef / etc. The agent has no need to run
  # raw GraphQL mutations; refuse any `gh api graphql` whose argv mentions a
  # mutation. Read-only GraphQL queries are still allowed.
  for t in "${tokens[@]}"; do
    if [ "$t" = "graphql" ]; then
      for arg in "$@"; do
        case "$arg" in
          *[Mm]utation*) refuse "gh api graphql (mutation)" ;;
          # A field value of the form `name=@file` or `name=@-` (gh's syntax
          # for "read this field from a file / stdin") is opaque to the
          # literal-argv mutation scan above — the actual query text never
          # appears in argv, so a mutation could hide inside a piped-in or
          # on-disk template and slip past unnoticed. Refuse rather than let
          # an unscannable body through (review: gemini-code-assist high-priority).
          *=@*) refuse "gh api graphql (field value from file/stdin)" ;;
          # `--input <file>` / `--input -` replaces the *entire* request body
          # with file/stdin content — a different mechanism than `-f
          # field=@file` above, and equally opaque to argv scanning. A mutation
          # sent this way (e.g. `gh api graphql --input payload.json` where
          # payload.json contains `{"query":"mutation{...}"}`) has no
          # "mutation" substring and no `=@` pattern anywhere in argv, so it
          # would otherwise sail through untouched (review: claude[bot]
          # high-priority). Refuse outright rather than let an unscannable
          # body through.
          --input|--input=*) refuse "gh api graphql (--input; body opaque to scan)" ;;
        esac
      done
      break
    fi
  done

  # The endpoint may be given as `/…`, `repos/…`, or a full URL. Normalise to a
  # leading-slash path so the guards below see the path component regardless of
  # form (REV-COR-316).
  path=""
  for t in "${tokens[@]}"; do
    case "$t" in
      https://*|http://*)
        rest="${t#*://}"      # strip scheme://
        path="/${rest#*/}"    # strip host, keep /path…
        break ;;
      /*)      path="$t" ; break ;;
      repos/*) path="/$t" ; break ;;
    esac
  done

  # Strip a query string and any trailing slash(es) so a caller can't dodge
  # the path-based guards below by appending `/` or `?x=y` — bash `case`
  # glob matching lets `*` match zero-length strings, so `/repos/o/r/`
  # would otherwise match the "deeper sub-resource" pattern instead of the
  # repo-root pattern, and `.../pulls/1/merge/` would no longer end in the
  # literal `merge` the raw-PR-merge guard matches on.
  path="${path%%\?*}"
  while true; do
    case "$path" in
      ?*/) path="${path%/}" ;;
      *) break ;;
    esac
  done

  # DELETE via raw api covers repo delete, branch delete, release
  # delete, pr close (also rejected above by name), etc.
  if [ "$method" = "DELETE" ]; then
    refuse "gh api -X DELETE $path"
  fi

  # Raw repo edit via PATCH/PUT on the repo root (REV-INFRA-003): the named
  # `gh repo edit` is blocked above, so block its raw-API equivalent too.
  # Only the repo root (/repos/OWNER/REPO) — deeper sub-resources are allowed.
  if [ "$method" = "PATCH" ] || [ "$method" = "PUT" ]; then
    case "$path" in
      /repos/*/*/*) : ;;                         # deeper sub-resource — allowed
      /repos/*/*)   refuse "gh api -X $method $path (raw repo edit)" ;;
    esac
  fi

  # Path-based blocks: raw API PR merge, branch protection bypass. These apply
  # for any method (the merge/protection paths are inherently state-changing).
  case "$path" in
    */pulls/*/merge)
      refuse "gh api ... $path (raw PR merge)" ;;
    */branches/*/protection|*/branches/*/protection/*)
      refuse "gh api ... $path (branch protection)" ;;
  esac
fi

# Allowed — hand off to the real gh.
exec "$REAL_GH" "$@"
