#!/usr/bin/env bash
# Build and push the PSD Agent base image to ECR.
#
# Usage:
#   ./build-and-push.sh                    # Uses default tag: YYYY-MM-DD-initial
#   ./build-and-push.sh my-custom-tag      # Uses custom tag
#
# Prerequisites:
#   - AWS CLI configured with appropriate credentials
#   - Docker running (with ARM64/linux/arm64 build support)
#   - CDK stacks deployed (ECR repository must exist)
#
# The script reads the ECR repository URI from CloudFormation outputs.

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-dev}"
# Capitalize first letter for stack name (portable — no bashisms or GNU sed)
ENV_CAPITALIZED="$(echo "${ENVIRONMENT}" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
STACK_NAME="AIStudio-AgentPlatformStack-${ENV_CAPITALIZED}"
REGION="${AWS_REGION:-us-east-1}"
TAG="${1:-$(date +%Y-%m-%d)-initial}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== PSD Agent Image Build & Push ==="
echo "Environment: ${ENVIRONMENT}"
echo "Tag: ${TAG}"
echo ""

# Supply-chain enforcement gate (SEC-009): the agent image must ship no
# unresolved BLOCKER(prod) markers. Every install in the Dockerfile is
# expected to be checksum- or hash-verified; a lingering BLOCKER(prod)
# comment means a known supply-chain gap is still open. Fail the build
# before doing any expensive work if any marker remains.
echo "Checking for unresolved BLOCKER(prod) markers in Dockerfile..."
# Fail closed if the Dockerfile can't be read: an `if grep ...` condition is
# exempt from `set -e`, and grep's "no match" (exit 1) and "error" (exit 2,
# e.g. unreadable/missing file) are indistinguishable to the `if`. Without
# this guard a broken checkout would silently report "OK" and skip the gate.
if [ ! -r "${SCRIPT_DIR}/Dockerfile" ]; then
  echo "ERROR: cannot read ${SCRIPT_DIR}/Dockerfile — the supply-chain gate could not run." >&2
  exit 1
fi
if grep -n 'BLOCKER(prod)' "${SCRIPT_DIR}/Dockerfile"; then
  echo "ERROR: BLOCKER(prod) marker(s) found in Dockerfile (see above)." >&2
  echo "       Resolve the supply-chain gap (checksum/hash verification) and" >&2
  echo "       remove the marker before building." >&2
  exit 1
fi
echo "  OK — no BLOCKER(prod) markers."
echo ""

# ---------------------------------------------------------------------------
# Build-time eval gate (issue #1161). The image is an artifact optimized
# against an evaluator: it must pass an automated gate BEFORE it is pushed, so
# the build loop stops being "deploy and chat." Four checks —
#   1. instruction-budget gate   (static, no Docker)   — over-budget bootstrap
#   2. config self-consistency   (static, no Docker)   — bad contextWindow / apiKey
#   3. boot probe                (runtime, needs image) — dead-boot (no BOOT_OK)
#   4. canary turn               (runtime, needs image) — non-answering agent
# Would have stopped r10 (dead-boot), r11 (missing provider), and the weeks-long
# SOUL.md truncation on a laptop instead of in prod.
#
# Two separate bypasses, so an emergency doesn't disable more than it must:
#   SKIP_PROBE_GATE=1   skips only the RUNTIME boot-probe + canary turn (checks
#                       3-4) — reserved for a broken probe blocking releases.
#   SKIP_STATIC_GATE=1  skips the cheap STATIC checks (1-2). These are pure file
#                       checks with no external dependency and essentially never
#                       need bypassing — this exists only for a true emergency,
#                       and is deliberately a DIFFERENT flag so SKIP_PROBE_GATE
#                       can't silently disable the instruction-budget /
#                       config-consistency gates that guard the #1138 class.
# Static gates run fail-fast here (before the expensive ECR/build steps); the
# runtime probe runs after the image is built, before push.
PYTHON="${PYTHON:-python3}"

if [ "${SKIP_STATIC_GATE:-0}" = "1" ]; then
  echo "WARNING: SKIP_STATIC_GATE=1 — static eval gates BYPASSED (emergency only)."
  echo ""
else
  echo "=== Build-time eval gate (1161): static checks ==="

  echo "1. Instruction-budget gate (bootstrap files vs openclaw.json limits)..."
  if ! "${PYTHON}" "${SCRIPT_DIR}/check_bootstrap_budget.py" --source-dir "${SCRIPT_DIR}"; then
    echo "ERROR: instruction-budget gate FAILED — a bootstrap file would be" >&2
    echo "       silently truncated at boot. Trim it before building." >&2
    exit 1
  fi
  echo ""

  echo "2. Config self-consistency (contextWindow + apiKey hydration)..."
  if ! "${PYTHON}" "${SCRIPT_DIR}/check_config_consistency.py" \
        --config "${SCRIPT_DIR}/openclaw.json" \
        --wrapper "${SCRIPT_DIR}/agentcore_wrapper.py"; then
    echo "ERROR: config self-consistency gate FAILED (see above)." >&2
    exit 1
  fi
  echo ""
fi

# Get ECR repository URI from CloudFormation outputs
echo "Looking up ECR repository from stack ${STACK_NAME}..."
ECR_URI=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='ECRRepositoryUri'].OutputValue" \
  --output text \
  --region "${REGION}")

if [ -z "${ECR_URI}" ] || [ "${ECR_URI}" = "None" ]; then
  echo "ERROR: Could not find ECR repository URI. Is the stack deployed?"
  echo "  Deploy first: cd infra && bunx cdk deploy ${STACK_NAME}"
  exit 1
fi

# Extract registry (account.dkr.ecr.region.amazonaws.com)
ECR_REGISTRY="${ECR_URI%%/*}"

echo "ECR URI: ${ECR_URI}"
echo "Registry: ${ECR_REGISTRY}"
echo ""

# Authenticate Docker with ECR
echo "Authenticating with ECR..."
aws ecr get-login-password --region "${REGION}" | \
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# Build the image (ARM64 for AgentCore)
echo ""
echo "Building image (ARM64)..."
docker build \
  --platform linux/arm64 \
  -t "${ECR_URI}:${TAG}" \
  "${SCRIPT_DIR}"

# ---------------------------------------------------------------------------
# Build-time eval gate (issue #1161): runtime boot probe + canary turn.
# Runs the freshly-built image with canary credentials and refuses to push a
# dead-boot or non-answering image. Probe results (pass/fail + latency) are
# written to a build artifact so canary quality is trendable across builds.
#
# Needs the Bedrock canary secret (for provider hydration + a real model call).
# Resolution order: AGENT_CANARY_SECRET_ARN env -> the stack's
# BedrockApiKeySecretArn CFN output. If neither resolves (e.g. the output isn't
# deployed yet, or no canary creds on this host) the runtime probe is SKIPPED
# with a loud warning — the static gates above still gate the build. Set
# REQUIRE_PROBE_GATE=1 to make an un-runnable probe a hard failure instead.
if [ "${SKIP_PROBE_GATE:-0}" = "1" ]; then
  echo ""
  echo "WARNING: SKIP_PROBE_GATE=1 — runtime boot/canary probe BYPASSED."
else
  echo ""
  echo "=== Build-time eval gate (1161): runtime boot probe + canary turn ==="
  CANARY_SECRET_ARN="${AGENT_CANARY_SECRET_ARN:-}"
  if [ -z "${CANARY_SECRET_ARN}" ]; then
    CANARY_SECRET_ARN=$(aws cloudformation describe-stacks \
      --stack-name "${STACK_NAME}" \
      --query "Stacks[0].Outputs[?OutputKey=='BedrockApiKeySecretArn'].OutputValue" \
      --output text --region "${REGION}" 2>/dev/null || echo "")
    [ "${CANARY_SECRET_ARN}" = "None" ] && CANARY_SECRET_ARN=""
  fi

  PROBE_DIR="${PROBE_ARTIFACT_DIR:-${SCRIPT_DIR}/.build-probes}"
  mkdir -p "${PROBE_DIR}"
  PROBE_ARTIFACT="${PROBE_DIR}/${TAG}.json"

  if [ -z "${CANARY_SECRET_ARN}" ]; then
    MSG="runtime probe SKIPPED — no canary secret (set AGENT_CANARY_SECRET_ARN or deploy the BedrockApiKeySecretArn output). Static gates still enforced."
    echo "WARNING: ${MSG}"
    printf '{"tag":"%s","skipped":true,"reason":"no_canary_secret"}\n' "${TAG}" > "${PROBE_ARTIFACT}"
    if [ "${REQUIRE_PROBE_GATE:-0}" = "1" ]; then
      echo "ERROR: REQUIRE_PROBE_GATE=1 but ${MSG}" >&2
      exit 1
    fi
    PROBE_RAN="false"
  else
    PROBE_RAN="true"
    PROBE_TIMEOUT="${PROBE_BOOT_TIMEOUT:-120}"
    CANARY_MESSAGE="${CANARY_MESSAGE:-Reply with exactly: OK}"
    CID=""
    # Always reap the probe container, even on failure/exit.
    cleanup_probe() { [ -n "${CID}" ] && docker rm -f "${CID}" >/dev/null 2>&1 || true; }
    trap cleanup_probe EXIT

    echo "Starting probe container (secret=${CANARY_SECRET_ARN##*:})..."
    # Pass through host AWS creds only when present. Build an array (rather than
    # unquoted ${VAR:+...} word-splitting) so the args are robust regardless of
    # the credential alphabet / IFS.
    PROBE_ENV_ARGS=(-e "ENVIRONMENT=${ENVIRONMENT}" -e "AWS_REGION=${REGION}"
      -e "BUILD_MARKER=${TAG}@probe" -e "BEDROCK_API_KEY_SECRET_ARN=${CANARY_SECRET_ARN}")
    [ -n "${AWS_ACCESS_KEY_ID:-}" ] && PROBE_ENV_ARGS+=(-e "AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}")
    [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && PROBE_ENV_ARGS+=(-e "AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}")
    [ -n "${AWS_SESSION_TOKEN:-}" ] && PROBE_ENV_ARGS+=(-e "AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN}")
    CID=$(docker run -d --platform linux/arm64 "${PROBE_ENV_ARGS[@]}" "${ECR_URI}:${TAG}")

    # Boot probe: wait for BOOT_OK. BUILD_MARKER logged but no BOOT_OK within the
    # timeout is the r10 dead-boot signature -> fail the build (don't push).
    # Check the LOG for BOOT_OK before checking whether the container is still
    # running, so a container that logs BOOT_OK then crashes within a poll window
    # is diagnosed as "reached BOOT_OK then exited" (a distinct, real bug) rather
    # than misreported as a never-booted image.
    echo "Boot probe: waiting up to ${PROBE_TIMEOUT}s for BOOT_OK..."
    BOOT_START=$(date +%s)
    BOOT_OK="false"
    BOOT_FAIL_REASON="no BOOT_OK in ${PROBE_TIMEOUT}s"
    while [ "$(( $(date +%s) - BOOT_START ))" -lt "${PROBE_TIMEOUT}" ]; do
      if docker logs "${CID}" 2>&1 | grep -q "BOOT_OK"; then
        BOOT_OK="true"
        break
      fi
      if ! docker ps -q --no-trunc | grep -q "${CID}"; then
        BOOT_FAIL_REASON="container exited before logging BOOT_OK"
        break
      fi
      sleep 3
    done
    BOOT_ELAPSED=$(( $(date +%s) - BOOT_START ))

    if [ "${BOOT_OK}" != "true" ]; then
      echo "ERROR: dead-boot — ${BOOT_FAIL_REASON} (BUILD_MARKER present)." >&2
      docker logs "${CID}" 2>&1 | tail -40 >&2
      printf '{"tag":"%s","boot_ok":false,"boot_elapsed_s":%s,"canary_ok":false}\n' \
        "${TAG}" "${BOOT_ELAPSED}" > "${PROBE_ARTIFACT}"
      exit 1
    fi
    echo "  Boot probe PASSED (BOOT_OK in ${BOOT_ELAPSED}s)."

    # Canary turn: a one-shot agent turn through the wrapper's /invocations
    # HTTP endpoint — the exact path AgentCore InvokeAgentRuntime drives in
    # production. Deliberately NOT `openclaw agent`: the gateway auth token is
    # generated per container inside the wrapper process and never written to
    # disk (REV-INFRA-005, harness_adapter.py), so no docker-exec CLI can ever
    # authenticate to the gateway. /invocations needs no token and exercises
    # wrapper -> adapter -> gateway -> model end to end.
    #
    # BOOT_OK is emitted just BEFORE app.run() binds the HTTP listener
    # (agentcore_wrapper.py, tail of main), so poll briefly until the port
    # accepts. Any HTTP response (even 404) means the listener is up; only
    # connection failures keep polling.
    for _ in $(seq 1 15); do
      docker exec "${CID}" curl -s -o /dev/null -m 2 "http://127.0.0.1:8080/ping" 2>/dev/null && break
      sleep 2
    done

    # Capture the real exit status (do NOT `|| true` it away): a failed curl
    # (HTTP error, timeout) must fail the build. The endpoint streams SSE
    # `data: {...}` events; the answer is the `result` field of the final
    # event. Extract JUST that field before matching — the raw stream echoes
    # the prompt inside metadata.messages, so grepping the whole body would
    # false-pass on the echoed "Reply with exactly: OK".
    echo "Canary turn: '${CANARY_MESSAGE}' (via /invocations)..."
    CANARY_TIMEOUT="${PROBE_CANARY_TIMEOUT:-120}"
    CANARY_PAYLOAD=$("${PYTHON}" -c \
      'import json, sys; print(json.dumps({"prompt": sys.argv[1], "user_email": "canary@build-gate"}))' \
      "${CANARY_MESSAGE}")
    CANARY_START=$(date +%s)
    CANARY_OUT=$(docker exec "${CID}" curl -sS -f -m "${CANARY_TIMEOUT}" \
      -X POST "http://127.0.0.1:8080/invocations" \
      -H "Content-Type: application/json" -d "${CANARY_PAYLOAD}" 2>&1) \
      && CANARY_STATUS=0 || CANARY_STATUS=$?
    CANARY_ELAPSED=$(( $(date +%s) - CANARY_START ))
    CANARY_ANSWER=$(printf '%s' "${CANARY_OUT}" | "${PYTHON}" -c '
import json, sys
answer = ""
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("data: "):
        continue
    try:
        event = json.loads(line[len("data: "):])
    except ValueError:
        continue
    if isinstance(event, dict) and "result" in event:
        answer = str(event.get("result") or "")
print(answer)')
    echo "    [canary] answer: ${CANARY_ANSWER:-<none>}"

    # Match the extracted answer with a word-bounded, case-SENSITIVE 'OK' — a
    # bare `grep -qi ok` false-passes on strings that merely CONTAIN the
    # substring ("token", "broken", "ExpiredTokenException", "look").
    if [ "${CANARY_STATUS}" -eq 0 ] \
       && printf '%s' "${CANARY_ANSWER}" | grep -Eq '(^|[^A-Za-z])OK([^A-Za-z]|$)'; then
      echo "  Canary turn PASSED (answered in ${CANARY_ELAPSED}s)."
      CANARY_OK="true"
    else
      echo "ERROR: canary turn failed (exit=${CANARY_STATUS}) or produced no 'OK' answer." >&2
      printf '%s\n' "${CANARY_OUT}" | tail -5 | sed 's/^/    [canary-raw] /' >&2
      CANARY_OK="false"
    fi

    printf '{"tag":"%s","boot_ok":true,"boot_elapsed_s":%s,"canary_ok":%s,"canary_elapsed_s":%s}\n' \
      "${TAG}" "${BOOT_ELAPSED}" "${CANARY_OK}" "${CANARY_ELAPSED}" > "${PROBE_ARTIFACT}"
    echo "  Probe artifact: ${PROBE_ARTIFACT}"

    cleanup_probe; CID=""; trap - EXIT
    if [ "${CANARY_OK}" != "true" ]; then
      exit 1
    fi
  fi
  if [ "${PROBE_RAN}" = "true" ]; then
    echo "=== Eval gate PASSED — image is boot-verified and answers ==="
  else
    echo "=== Eval gate PASSED (static checks only — runtime probe skipped; image NOT boot-verified) ==="
  fi
  echo ""
fi

echo ""
echo "Pushing ${ECR_URI}:${TAG}..."
docker push "${ECR_URI}:${TAG}"

# Resolve the immutable digest so the caller can pin AgentCore by digest.
# Tag-based pinning has produced stale image serving in AgentCore — see PR #902.
echo ""
echo "Resolving image digest..."
DIGEST=$(aws ecr describe-images \
  --region "${REGION}" \
  --repository-name "${ECR_URI##*/}" \
  --image-ids "imageTag=${TAG}" \
  --query 'imageDetails[0].imageDigest' \
  --output text)

echo ""
echo "=== Done ==="
echo ""
echo "Image:  ${ECR_URI}:${TAG}"
echo "Digest: ${DIGEST}"
echo ""
echo "Next step — deploy AgentCore Runtime pinned to the immutable digest:"
echo ""
echo "  cd infra && bunx cdk deploy ${STACK_NAME} \\"
echo "    --context agentImageTag=${TAG} \\"
echo "    --context agentImageDigest=${DIGEST}"
echo ""
echo "After deploy, confirm the running build via CloudWatch:"
echo "  aws logs tail /aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT \\"
echo "    --region ${REGION} --since 5m | grep BUILD_MARKER"
