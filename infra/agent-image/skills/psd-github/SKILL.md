---
name: psd-github
summary: GitHub operations via the `gh` CLI. Auth is hydrated automatically by the wrapper on each invocation.
description: GitHub CLI operations for issues, PRs, repo queries, and any GitHub API interaction. The agent wrapper hydrates `gh` auth from each user's `github_pat` credential on every invocation — no manual auth-restore step is required.
allowed-tools: Bash(gh:*)
---

# psd-github

GitHub CLI access for the agent. `gh` is baked into the image at
`/usr/local/bin/gh`.

## Authentication

You do not need to authenticate `gh` yourself. The agent wrapper writes
`~/.config/gh/hosts.yml` from the caller's per-user `github_pat`
credential at the start of every invocation (see `hydrate_github_auth`
in `agentcore_wrapper.py`). If the caller has not provisioned a PAT,
`gh` calls will fail with an auth error — that is the user's signal to
add their PAT via `psd-credentials`.

To check status:

```bash
gh auth status
```

If `gh auth status` reports "not authenticated", the caller is missing
a `github_pat` credential. Direct them to add one with the
`psd-credentials` skill.

## Commands

### Issues

```bash
# Create an issue
gh issue create --repo <owner/repo> --title "<title>" --body "<body>" [--label "<label>"]

# List open issues
gh issue list --repo <owner/repo> --state open

# Filter by label
gh issue list --repo <owner/repo> --label "<label>" --state open

# My assigned issues
gh issue list --repo <owner/repo> --assignee @me --state open

# View one
gh issue view <issue-number> --repo <owner/repo>
```

### Pull requests

```bash
# Create
gh pr create --repo <owner/repo> --title "<title>" --body "<body>" [--base <branch>]

# List
gh pr list --repo <owner/repo> --state open

# View
gh pr view <pr-number> --repo <owner/repo>

# Check status
gh pr checks <pr-number> --repo <owner/repo>
```

### Search

```bash
gh search repos "<query>" --json name,owner,url
gh search issues "<query>" --repo <owner/repo>
```

### Raw API

```bash
gh api repos/<owner>/<repo>/issues/<num>/comments
```

## Rules

1. **Do not log or echo the PAT.** It is hydrated to disk by the wrapper
   and read transparently by `gh`. There is no need to surface the value.
2. **Prefer `gh` CLI over raw `curl`** — `gh` handles pagination, auth,
   and formatting automatically.
3. **Repos and labels are caller-specific.** Ask the caller which
   repository to operate on; do not assume a default.

## Examples

**Create an issue:**

```bash
gh issue create --repo psd401/aistudio \
  --title "Short title" \
  --body "Longer description" \
  --label "bug"
```

**Find recent issues you've filed:**

```bash
gh issue list --repo psd401/aistudio --author @me --state all --limit 10
```
