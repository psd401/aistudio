#!/usr/bin/env bash
# Regression tests for gh-wrapper.sh. Runs the wrapper against a stub gh.real
# (via GH_REAL) and asserts the blocklist. No network, no real gh.
# Run: bash infra/agent-image/bin/gh-wrapper.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$HERE/gh-wrapper.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Stub gh.real: records argv and exits 0, so "allowed" commands are observable.
STUB="$WORK/gh.real"
cat > "$STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$WORK/last_args"
exit 0
EOF
chmod +x "$STUB"

pass=0 fail=0

# refused: wrapper must exit 2 (never reaching the stub)
refuse_case() {
  local desc="$1"; shift
  rm -f "$WORK/last_args"
  GH_REAL="$STUB" GH_CONFIG_DIR="$WORK/ghcfg" bash "$WRAPPER" "$@" >/dev/null 2>&1
  local rc=$?
  if [ "$rc" -eq 2 ] && [ ! -f "$WORK/last_args" ]; then
    pass=$((pass+1)); echo "ok   refuse: $desc"
  else
    fail=$((fail+1)); echo "FAIL refuse: $desc (exit $rc, stub_reached=$([ -f "$WORK/last_args" ] && echo yes || echo no))"
  fi
}

# allowed: wrapper must exit 0 and delegate to the stub
allow_case() {
  local desc="$1"; shift
  rm -f "$WORK/last_args"
  GH_REAL="$STUB" GH_CONFIG_DIR="$WORK/ghcfg" bash "$WRAPPER" "$@" >/dev/null 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ] && [ -f "$WORK/last_args" ]; then
    pass=$((pass+1)); echo "ok   allow:  $desc"
  else
    fail=$((fail+1)); echo "FAIL allow:  $desc (exit $rc, stub_reached=$([ -f "$WORK/last_args" ] && echo yes || echo no))"
  fi
}

mkdir -p "$WORK/ghcfg"

# --- REV-COR-316: full-URL / graphql / lowercase-method api bypasses ---
refuse_case "api -X PUT full-URL pulls merge" api -X PUT https://api.github.com/repos/o/r/pulls/1/merge
refuse_case "api graphql mutation"            api graphql -f 'query=mutation{mergePullRequest(input:{})}'
refuse_case "api -X delete (lowercase)"        api -X delete /repos/o/r
# --- REV-INFRA-003: PATCH repo-edit + method case-insensitivity ---
refuse_case "api -X PATCH repo edit"           api -X PATCH /repos/o/r -f visibility=public
refuse_case "api -X put full-URL merge (lc)"   api -X put https://api.github.com/repos/o/r/pulls/2/merge
# --- existing name rules still fire ---
refuse_case "pr merge"                          pr merge 1
refuse_case "repo delete"                       repo delete o/r
refuse_case "api -X DELETE repos"               api -X DELETE /repos/o/r
refuse_case "api repos-form pulls merge"        api repos/o/r/pulls/1/merge -X POST
# --- REV-INFRA-004: alias surface ---
refuse_case "alias set"                         alias set m 'pr merge'
refuse_case "alias set --shell"                 alias set x --shell 'echo hi'
refuse_case "alias import"                       alias import -

# --- allowed: reads + reversible + deeper sub-resources ---
allow_case "api GET repos"                       api GET /repos/o/r
allow_case "api list pulls"                       api /repos/o/r/pulls
allow_case "api graphql read-only query"          api graphql -f 'query=query{viewer{login}}'
allow_case "api PATCH deeper sub-resource"        api -X PATCH /repos/o/r/pulls/1 -f title=x
allow_case "pr create"                            pr create --title x --body y
allow_case "issue close"                          issue close 1
allow_case "alias list"                            alias list

# --- REV-INFRA-004: a pre-seeded config alias is stripped and cannot expand ---
mkdir -p "$WORK/ghcfg"
cat > "$WORK/ghcfg/config.yml" <<'EOF'
git_protocol: https
aliases:
    m: pr merge
    co: pr checkout
editor: vim
EOF
rm -f "$WORK/last_args"
GH_REAL="$STUB" GH_CONFIG_DIR="$WORK/ghcfg" bash "$WRAPPER" m 123 >/dev/null 2>&1
if grep -q '^aliases:' "$WORK/ghcfg/config.yml"; then
  fail=$((fail+1)); echo "FAIL alias-strip: aliases: still present in config"
elif grep -q 'git_protocol: https' "$WORK/ghcfg/config.yml" && grep -q 'editor: vim' "$WORK/ghcfg/config.yml"; then
  pass=$((pass+1)); echo "ok   alias-strip: aliases removed, other config preserved"
else
  fail=$((fail+1)); echo "FAIL alias-strip: non-alias config was damaged"
fi

echo "----"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
