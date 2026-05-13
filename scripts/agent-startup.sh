#!/usr/bin/env bash
# Agent container startup script.
#
# Runs at the start of each Claude Code web session via the SessionStart hook
# declared in .claude/settings.json. Solves the ephemeral-container problem
# (issue #969): GitHub CLI auth and custom skills are wiped on restart.
#
# What it does:
#   1. Restores GitHub CLI auth by fetching github_pat from AWS Secrets Manager
#      (secret name: psd-credentials, key: github_pat) or the GITHUB_PAT env var.
#   2. Clones/updates psd401/psd-claude-plugins and copies skills into both
#      ~/.claude/skills/ and ~/.openclaw/skills/.
#   3. Copies agent sub-prompts into ~/.claude/agents/.
#
# Security notes:
#   - PAT value is never echoed to stdout/stderr.
#   - skill_name values are validated against ^[a-zA-Z0-9_-]+$ before any rm -rf.
#   - Startup marker is stored in HOME (not /tmp) to avoid TOCTOU race.
#   - Local .env fallback enforces chmod 600 before reading.
#   - Both phases are non-fatal: failures are logged but do not abort the session.

set -uo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Idempotency guard — runs once per container lifetime (marker stored in HOME,
# not /tmp, to prevent TOCTOU by other local processes)
# ──────────────────────────────────────────────────────────────────────────────
STARTUP_MARKER="${HOME}/.psd-agent-startup-done"
if [ -f "$STARTUP_MARKER" ]; then
  echo "[agent-startup] Already ran this container session — skipping."
  exit 0
fi

echo "[agent-startup] PSD agent initialization starting..."
date -u +"[agent-startup] %Y-%m-%dT%H:%M:%SZ"
echo "[agent-startup] HOME=${HOME}  whoami=$(whoami 2>/dev/null || echo unknown)"

# ──────────────────────────────────────────────────────────────────────────────
# 1. Restore GitHub CLI authentication
# ──────────────────────────────────────────────────────────────────────────────
restore_github_auth() {
  # Already authenticated — nothing to do
  if timeout 15 gh auth status >/dev/null 2>&1; then
    echo "[agent-startup] GitHub CLI already authenticated."
    return 0
  fi

  echo "[agent-startup] GitHub CLI not authenticated. Attempting to restore..."

  local pat=""

  # Method 1: injected environment variable (platform-level secret injection)
  if [ -n "${GITHUB_PAT:-}" ]; then
    pat="$GITHUB_PAT"
    echo "[agent-startup] Found GITHUB_PAT environment variable."
  fi

  # Method 2: AWS Secrets Manager via boto3 — secret 'psd-credentials', key 'github_pat'
  # Uses boto3 (installed in the image) rather than the aws CLI (not in the image).
  if [ -z "$pat" ] && command -v python3 >/dev/null 2>&1; then
    echo "[agent-startup] Trying AWS Secrets Manager via boto3 (secret: psd-credentials)..."
    pat=$(python3 -c "
import boto3, json, sys
try:
    from botocore.config import Config
    c = boto3.client('secretsmanager', config=Config(connect_timeout=5, read_timeout=10, retries={'max_attempts': 1}))
    print(json.loads(c.get_secret_value(SecretId='psd-credentials')['SecretString']).get('github_pat', ''))
except Exception as e:
    sys.stderr.write('[agent-startup] boto3: ' + str(e) + '\n')
    print('')
" || echo "")
  fi

  # Method 3: local .env file (development / local sessions)
  # Enforces 600 permissions before reading to reduce exposure window.
  if [ -z "$pat" ]; then
    local env_file="${HOME}/.config/psd-productivity/.env"
    if [ -f "$env_file" ]; then
      chmod 600 "$env_file" 2>/dev/null || true
      pat=$(grep -E '^GITHUB_PAT=' "$env_file" \
        | cut -d= -f2- \
        | sed "s/^[\"']//;s/[\"']\$//" 2>/dev/null || echo "")
    fi
  fi

  if [ -z "$pat" ]; then
    echo "[agent-startup] WARNING: Could not retrieve github_pat from any source." >&2
    echo "[agent-startup]   → Set GITHUB_PAT env var, or ensure the 'psd-credentials'" >&2
    echo "[agent-startup]     AWS Secrets Manager secret is accessible from this session." >&2
    return 1
  fi

  # Pipe PAT directly to gh — never echo it to stdout or a log file.
  # printf avoids issues if the token starts with a hyphen.
  # WARNING: Do NOT run this script with 'bash -x' — set -x tracing prints
  #          the PAT value to stderr, leaking the token into session logs.
  if printf '%s\n' "$pat" | gh auth login --with-token 2>&1; then
    echo "[agent-startup] GitHub CLI authentication restored."
    timeout 15 gh auth status 2>/dev/null | head -4 >&2 || true
  else
    echo "[agent-startup] WARNING: 'gh auth login --with-token' failed." >&2
    return 1
  fi
}

# ──────────────────────────────────────────────────────────────────────────────
# 2. Restore skills and agents from psd401/psd-claude-plugins
# ──────────────────────────────────────────────────────────────────────────────

# Validate that a skill or agent name contains only safe characters.
# Prevents path traversal via a malicious repo entry (e.g. skill_name='../../../etc').
is_safe_name() {
  [[ "$1" =~ ^[a-zA-Z0-9_-]+$ ]]
}

restore_skills() {
  local clone_dir="/tmp/psd-plugins-session"
  local tmp_archive="/tmp/psd-plugins-session.tar.gz"

  echo "[agent-startup] Syncing psd401/psd-claude-plugins..."

  # git is not available in the agent image (purged to reduce image size).
  # Download the repo as a tarball via the GitHub API instead.
  # Use gh token for auth if available (supports private forks).
  local gh_token
  gh_token=$(gh auth token 2>/dev/null || echo "")

  rm -rf "$clone_dir" "$tmp_archive"
  mkdir -p "$clone_dir"

  local -a auth_args=()
  [ -n "$gh_token" ] && auth_args=(-H "Authorization: Bearer $gh_token")
  if ! curl -fsSL --connect-timeout 10 --max-time 60 "${auth_args[@]}" \
      "https://api.github.com/repos/psd401/psd-claude-plugins/tarball/main" \
      -o "$tmp_archive" 2>/dev/null; then
    echo "[agent-startup] WARNING: Could not download psd-claude-plugins. Skills not restored." >&2
    return 1
  fi

  if ! tar -xzf "$tmp_archive" -C "$clone_dir" --strip-components=1 2>/dev/null; then
    echo "[agent-startup] WARNING: Could not extract psd-claude-plugins archive. Skills not restored." >&2
    rm -f "$tmp_archive"
    return 1
  fi
  rm -f "$tmp_archive"

  echo "[agent-startup] psd-claude-plugins downloaded"

  local skill_dirs=(
    "$clone_dir/plugins/psd-coding-system/skills"
    "$clone_dir/plugins/psd-productivity/skills"
  )

  # Install skills into both ~/.claude/skills/ and ~/.openclaw/skills/
  for target in "${HOME}/.claude/skills" "${HOME}/.openclaw/skills"; do
    mkdir -p "$target"
    local count=0
    for plugin_root in "${skill_dirs[@]}"; do
      [ -d "$plugin_root" ] || continue
      while IFS= read -r skill_md; do
        local skill_dir skill_name
        skill_dir="$(dirname "$skill_md")"
        skill_name="$(basename "$skill_dir")"

        # Reject unsafe names — prevents path traversal from a malicious clone
        if ! is_safe_name "$skill_name"; then
          echo "[agent-startup] WARNING: Skipping skill with unsafe name: '$skill_name'" >&2
          continue
        fi

        rm -rf "${target:?}/$skill_name"
        cp -r "$skill_dir" "$target/$skill_name"
        count=$((count + 1))
      done < <(find "$plugin_root" -mindepth 2 -maxdepth 2 -name "SKILL.md" -type f)
    done
    echo "[agent-startup] Skills → $target: $count installed"
  done

  # Install agents into ~/.claude/agents/
  local agents_dir="${HOME}/.claude/agents"
  mkdir -p "$agents_dir"
  local agent_count=0
  local agents_src="$clone_dir/plugins/psd-coding-system/agents"
  if [ -d "$agents_src" ]; then
    while IFS= read -r agent_file; do
      local agent_name
      agent_name="$(basename "$agent_file" .md)"

      if ! is_safe_name "$agent_name"; then
        echo "[agent-startup] WARNING: Skipping agent with unsafe name: '$agent_name'" >&2
        continue
      fi

      cp "$agent_file" "$agents_dir/"
      agent_count=$((agent_count + 1))
    done < <(find "$agents_src" -maxdepth 1 -name "*.md" -type f)
  fi
  echo "[agent-startup] Agents → $agents_dir: $agent_count installed"
}

# ──────────────────────────────────────────────────────────────────────────────
# Run — both phases are non-fatal so a failure in one doesn't block the other.
# The startup marker is only written when BOTH phases succeed. This allows
# failed phases (e.g. transient AWS/network outage) to retry on the next
# SessionStart rather than being permanently skipped for the container lifetime.
# ──────────────────────────────────────────────────────────────────────────────
auth_rc=0; restore_github_auth || auth_rc=$?
skills_rc=0; restore_skills    || skills_rc=$?

if [ "$auth_rc" -eq 0 ] && [ "$skills_rc" -eq 0 ]; then
  touch "$STARTUP_MARKER"
else
  echo "[agent-startup] One or more phases failed (auth_rc=$auth_rc skills_rc=$skills_rc); will retry on next session." >&2
fi

echo "[agent-startup] Initialization complete."
date -u +"[agent-startup] %Y-%m-%dT%H:%M:%SZ"
