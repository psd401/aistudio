#!/usr/bin/env bash
# Agent container startup script.
#
# Runs at the start of each Claude Code web session via the SessionStart hook
# declared in .claude/settings.json. Solves the ephemeral-container problem
# (issue #969): GitHub CLI auth and custom skills are wiped on restart.
#
# What it does:
#   1. Restores GitHub CLI auth by fetching github_pat from psd-credentials
#      (AWS Secrets Manager) or the GITHUB_PAT env var.
#   2. Clones/updates psd401/psd-claude-plugins and copies all skills into
#      both ~/.claude/skills/ and ~/.openclaw/skills/ so they survive container
#      restarts via this hook rather than relying on ephemeral workarounds.
#   3. Copies agent sub-prompts into ~/.claude/agents/.
#
# Non-fatal: failures in either phase are logged but do not exit non-zero,
# so a broken credential or network blip does not abort the session.

set -uo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Idempotency guard — only run once per container lifetime
# ──────────────────────────────────────────────────────────────────────────────
STARTUP_MARKER="/tmp/.psd-agent-startup-done"
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
    echo "[agent-startup] Using GITHUB_PAT environment variable."
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
  if [ -z "$pat" ]; then
    local env_file="${HOME}/.config/psd-productivity/.env"
    if [ -f "$env_file" ]; then
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

  # Copy skills into ~/.claude/skills/ and ~/.openclaw/skills/
  local skill_dirs=(
    "$clone_dir/plugins/psd-coding-system/skills"
    "$clone_dir/plugins/psd-productivity/skills"
  )

  for target in "${HOME}/.claude/skills" "${HOME}/.openclaw/skills"; do
    mkdir -p "$target"
    local count=0
    for plugin_root in "${skill_dirs[@]}"; do
      [ -d "$plugin_root" ] || continue
      while IFS= read -r skill_md; do
        local skill_dir skill_name
        skill_dir="$(dirname "$skill_md")"
        skill_name="$(basename "$skill_dir")"
        rm -rf "${target:?}/$skill_name"
        cp -r "$skill_dir" "$target/$skill_name"
        count=$((count + 1))
      done < <(find "$plugin_root" -mindepth 2 -maxdepth 2 -name "SKILL.md" -type f)
    done
    echo "[agent-startup] Skills → $target: $count installed"
  done

  # Copy agents into ~/.claude/agents/
  local agents_dir="${HOME}/.claude/agents"
  mkdir -p "$agents_dir"
  local agent_count=0
  local agents_src="$clone_dir/plugins/psd-coding-system/agents"
  if [ -d "$agents_src" ]; then
    while IFS= read -r agent_file; do
      cp "$agent_file" "$agents_dir/"
      agent_count=$((agent_count + 1))
    done < <(find "$agents_src" -name "*.md" -type f)
  fi
  echo "[agent-startup] Agents → $agents_dir: $agent_count installed"
}

# ──────────────────────────────────────────────────────────────────────────────
# Run — both phases are non-fatal so a failure in one doesn't abort the other
# ──────────────────────────────────────────────────────────────────────────────
restore_github_auth || true
restore_skills       || true

touch "$STARTUP_MARKER"

echo "[agent-startup] Initialization complete."
date -u +"[agent-startup] %Y-%m-%dT%H:%M:%SZ"
