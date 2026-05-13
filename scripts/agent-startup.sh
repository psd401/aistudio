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
  if gh auth status >/dev/null 2>&1; then
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

  # Method 2: AWS Secrets Manager — secret 'psd-credentials', key 'github_pat'
  if [ -z "$pat" ] && command -v aws >/dev/null 2>&1; then
    echo "[agent-startup] Trying AWS Secrets Manager (secret: psd-credentials)..."
    local secret_json
    secret_json=$(aws secretsmanager get-secret-value \
      --secret-id psd-credentials \
      --query SecretString \
      --output text 2>/dev/null || echo "")
    if [ -n "$secret_json" ]; then
      pat=$(echo "$secret_json" | python3 -c \
        "import sys,json; d=json.load(sys.stdin); print(d.get('github_pat',''))" \
        2>/dev/null || echo "")
    fi
  fi

  # Method 3: local .env file (development / local sessions)
  # Enforces 600 permissions before reading to reduce exposure window.
  if [ -z "$pat" ]; then
    local env_file="${HOME}/.config/psd-productivity/.env"
    if [ -f "$env_file" ]; then
      chmod 600 "$env_file" 2>/dev/null || true
      pat=$(grep -E '^GITHUB_PAT=' "$env_file" \
        | cut -d= -f2- | tr -d '"'"'" 2>/dev/null || echo "")
    fi
  fi

  if [ -z "$pat" ]; then
    echo "[agent-startup] WARNING: Could not retrieve github_pat from any source." >&2
    echo "[agent-startup]   → Set GITHUB_PAT env var, or ensure the 'psd-credentials'" >&2
    echo "[agent-startup]     AWS Secrets Manager secret is accessible from this session." >&2
    return 1
  fi

  # Pipe PAT directly to gh — never echo it to stdout or a log file
  if echo "$pat" | gh auth login --with-token 2>&1; then
    echo "[agent-startup] GitHub CLI authentication restored."
    gh auth status 2>/dev/null | head -4
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

  echo "[agent-startup] Syncing psd401/psd-claude-plugins..."

  if [ -d "$clone_dir/.git" ]; then
    git -C "$clone_dir" pull --quiet --depth 1 origin main 2>/dev/null \
      || echo "[agent-startup] WARNING: git pull failed; using cached clone." >&2
  else
    rm -rf "$clone_dir"
    if ! git clone --depth 1 --branch main \
        https://github.com/psd401/psd-claude-plugins.git "$clone_dir" \
        2>&1 | tail -3; then
      echo "[agent-startup] WARNING: Could not clone psd-claude-plugins. Skills not restored." >&2
      return 1
    fi
  fi

  local head_sha
  head_sha=$(git -C "$clone_dir" rev-parse --short HEAD 2>/dev/null || echo "unknown")
  echo "[agent-startup] psd-claude-plugins @ ${head_sha}"

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
    done < <(find "$agents_src" -name "*.md" -type f)
  fi
  echo "[agent-startup] Agents → $agents_dir: $agent_count installed"
}

# ──────────────────────────────────────────────────────────────────────────────
# Run — both phases are non-fatal so a failure in one doesn't block the other
# ──────────────────────────────────────────────────────────────────────────────
restore_github_auth || true
restore_skills       || true

touch "$STARTUP_MARKER"

echo "[agent-startup] Initialization complete."
date -u +"[agent-startup] %Y-%m-%dT%H:%M:%SZ"
