#!/usr/bin/env bash
# Regression test for the model-facing GitHub compatibility entrypoint.
# Named-operation policy is tested in command-executor.test.ts; this test proves
# the container wrapper cannot dispatch a sibling binary or environment-selected
# executable and always delegates to the fixed broker helper.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE_WRAPPER="$HERE/gh-wrapper.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

HELPER="$WORK/github-cli.js"
cat > "$HELPER" <<'EOF'
const fs = require('node:fs');
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
EOF

WRAPPER="$WORK/gh-wrapper.sh"
sed "s|BROKER_HELPER=\"/opt/psd-skills/_shared/github-cli.js\"|BROKER_HELPER=\"$HELPER\"|" \
  "$SOURCE_WRAPPER" > "$WRAPPER"
chmod +x "$WRAPPER"

ARGS_FILE="$WORK/args" GH_REAL="/tmp/attacker" bash "$WRAPPER" \
  pr create --repo psd401/aistudio --title test
rc=$?

if [ "$rc" -ne 0 ]; then
  echo "FAIL broker delegation exited $rc"
  exit 1
fi
if [ "$(cat "$WORK/args")" != '["pr","create","--repo","psd401/aistudio","--title","test"]' ]; then
  echo "FAIL broker delegation changed argv"
  exit 1
fi
if rg -q 'REAL_GH=|/usr/local/bin/gh\.real|\$\{GH_REAL' "$SOURCE_WRAPPER"; then
  echo "FAIL wrapper still exposes a sibling-binary dispatcher"
  exit 1
fi

echo "ok   fixed broker helper receives argv"
echo "ok   GH_REAL environment override is inert"
echo "ok   no gh.real sibling path exists"
