#!/usr/bin/env bash
# Build and push the PSD Agent base image to ECR.
#
# Usage:
#   ./build-and-push.sh                    # Uses default tag: YYYY-MM-DD-initial
#   ./build-and-push.sh my-custom-tag      # Uses custom tag
#   ./build-and-push.sh --candidate eval/candidates/manifests/glm-5-native.json [tag]
#
# Prerequisites:
#   - AWS CLI configured with appropriate credentials
#   - Docker running (with ARM64/linux/arm64 build support)
#   - CDK stacks deployed (ECR repository must exist)
#
# The script reads the ECR repository URI from CloudFormation outputs.
#
# Build-time eval gate (#1161): the image must prove it boots and answers a real
# turn before it is pushed. The runtime half needs a signed broker context; this
# script mints one automatically when your AWS credentials allow it. If it
# cannot, the build FAILS rather than pushing an unverified image — override
# with ALLOW_UNVERIFIED_IMAGE=1 only when you accept that.
# Full reference: docs/operations/agent-image-build-gate.md

set -euo pipefail

CANDIDATE_MANIFEST=""
if [ "${1:-}" = "--candidate" ]; then
  if [ -z "${2:-}" ]; then
    echo "ERROR: --candidate requires a manifest path." >&2
    exit 2
  fi
  CANDIDATE_MANIFEST="${2}"
  shift 2
fi
if [ "$#" -gt 1 ]; then
  echo "ERROR: unexpected extra arguments." >&2
  exit 2
fi

ENVIRONMENT="${ENVIRONMENT:-dev}"
# Capitalize first letter for stack name (portable — no bashisms or GNU sed)
ENV_CAPITALIZED="$(echo "${ENVIRONMENT}" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
STACK_NAME="AIStudio-AgentPlatformStack-${ENV_CAPITALIZED}"
REGION="${AWS_REGION:-us-east-1}"
TAG="${1:-$(date +%Y-%m-%d)-initial}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
if ! [[ "${TAG}" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
  echo "ERROR: image tag must contain only letters, digits, dot, underscore, or hyphen." >&2
  exit 2
fi

BUILD_CONFIG="${SCRIPT_DIR}/openclaw.json"
BUILD_DOCKERFILE="${SCRIPT_DIR}/Dockerfile"
BOOTSTRAP_SOURCE_DIR="${SCRIPT_DIR}"
CANDIDATE_STAGING=""
CANDIDATE_METADATA=""
CANDIDATE_ID=""
CANDIDATE_PROVIDER_PATH=""
CANDIDATE_REQUIRES_BEARER="false"
OPENCLAW_CONFIG_BUILD_PATH="openclaw.json"
SOUL_PREAMBLE_BUILD_PATH="SOUL.md"
PSD_RULES_BUILD_PATH="skills/psd-rules/SKILL.md"
OPENCLAW_BASE_IMAGE=""
BEDROCK_PLUGIN_VERSION=""
BEDROCK_PLUGIN_EXPECTED_TOKEN=""
CID=""

cleanup_build() {
  if [ -n "${CID}" ]; then
    docker rm -f "${CID}" >/dev/null 2>&1 || true
  fi
  rm -f "${SCRIPT_DIR}/skills/validated-fs.cjs"
  case "${CANDIDATE_STAGING}" in
    "${SCRIPT_DIR}"/.candidate-staging.*)
      rm -rf -- "${CANDIDATE_STAGING}"
      ;;
  esac
}
trap cleanup_build EXIT

SOURCE_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
if ! [[ "${SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: could not resolve a full Git commit for image provenance." >&2
  exit 1
fi
if [ -n "$(git -C "${REPO_ROOT}" status --porcelain --untracked-files=all -- \
    infra/agent-image infra/validated-fs.cjs)" ]; then
  echo "ERROR: agent-image sources are dirty; commit them before building." >&2
  echo "       Image provenance must identify the exact source content." >&2
  exit 1
fi

PYTHON="${PYTHON:-python3}"
if [ -n "${CANDIDATE_MANIFEST}" ]; then
  CANDIDATE_STAGING="$(mktemp -d "${SCRIPT_DIR}/.candidate-staging.XXXXXX")"
  CANDIDATE_PLAN="${CANDIDATE_STAGING}/plan.json"
  "${PYTHON}" "${SCRIPT_DIR}/eval/candidates/candidate.py" prepare \
    --manifest "${CANDIDATE_MANIFEST}" \
    --output-dir "${CANDIDATE_STAGING}" \
    --source-commit "${SOURCE_COMMIT}" >/dev/null

  candidate_plan_value() {
    "${PYTHON}" -c \
      'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))[sys.argv[2]])' \
      "${CANDIDATE_PLAN}" "$1"
  }
  CANDIDATE_ID="$(candidate_plan_value candidateId)"
  CANDIDATE_PROVIDER_PATH="$(candidate_plan_value providerPath)"
  CANDIDATE_REQUIRES_BEARER="$(candidate_plan_value requiresBearerToken | tr '[:upper:]' '[:lower:]')"
  OPENCLAW_CONFIG_BUILD_PATH="$(candidate_plan_value openclawConfig)"
  BUILD_CONFIG="${SCRIPT_DIR}/${OPENCLAW_CONFIG_BUILD_PATH}"
  BUILD_DOCKERFILE="$(candidate_plan_value dockerfile)"
  BOOTSTRAP_SOURCE_DIR="${CANDIDATE_STAGING}"
  SOUL_PREAMBLE_BUILD_PATH="$(candidate_plan_value soulPreamble)"
  PSD_RULES_BUILD_PATH="$(candidate_plan_value psdRulesSkill)"
  OPENCLAW_BASE_IMAGE="$(candidate_plan_value baseImage)"
  BEDROCK_PLUGIN_VERSION="$(candidate_plan_value bedrockPluginVersion)"
  BEDROCK_PLUGIN_EXPECTED_TOKEN="$(candidate_plan_value expectedPluginToken)"
  CANDIDATE_METADATA="$(candidate_plan_value metadata)"
fi

echo "=== PSD Agent Image Build & Push ==="
echo "Environment: ${ENVIRONMENT}"
echo "Tag: ${TAG}"
echo "Source commit: ${SOURCE_COMMIT}"
if [ -n "${CANDIDATE_ID}" ]; then
  echo "Candidate: ${CANDIDATE_ID} (${CANDIDATE_PROVIDER_PATH})"
fi
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
if [ "${SKIP_STATIC_GATE:-0}" = "1" ]; then
  echo "WARNING: SKIP_STATIC_GATE=1 — static eval gates BYPASSED (emergency only)."
  echo ""
else
  echo "=== Build-time eval gate (1161): static checks ==="

  echo "1. Instruction-budget gate (bootstrap files vs openclaw.json limits)..."
  if ! "${PYTHON}" "${SCRIPT_DIR}/check_bootstrap_budget.py" \
        --config "${BUILD_CONFIG}" \
        --source-dir "${BOOTSTRAP_SOURCE_DIR}"; then
    echo "ERROR: instruction-budget gate FAILED — a bootstrap file would be" >&2
    echo "       silently truncated at boot. Trim it before building." >&2
    exit 1
  fi
  echo ""

  # --verify-upstream resolves the base-image tag against ghcr and reads the
  # plugin's published peerDependencies.openclaw from the npm registry. The
  # offline checks compare hand-maintained copies of those facts and cannot
  # prove either one; this is the build, it has network, so it gates on the
  # real values. A host/plugin mismatch is invisible otherwise — `npm pack`
  # never enforces peerDependencies.
  echo "2. Config self-consistency (contextWindow + apiKey hydration + pins)..."
  if ! "${PYTHON}" "${SCRIPT_DIR}/check_config_consistency.py" \
        --config "${BUILD_CONFIG}" \
        --wrapper "${SCRIPT_DIR}/agentcore_wrapper.py" \
        --dockerfile "${BUILD_DOCKERFILE}" \
        --verify-upstream; then
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
# Stage the canonical fs validator into the build context: skill files require
# ../../../validated-fs.cjs, which resolves to /validated-fs.cjs in-container —
# the Dockerfile symlinks that to this staged copy inside /opt/psd-skills.
# Staged (gitignored) rather than checked in twice, so it can never drift from
# infra/validated-fs.cjs.
cp "${SCRIPT_DIR}/../validated-fs.cjs" "${SCRIPT_DIR}/skills/validated-fs.cjs"
DOCKER_BUILD_ARGS=(
  --platform linux/arm64
  --build-arg "AISTUDIO_SOURCE_COMMIT=${SOURCE_COMMIT}"
  -f "${SCRIPT_DIR}/Dockerfile"
  -t "${ECR_URI}:${TAG}"
)
if [ -n "${CANDIDATE_ID}" ]; then
  DOCKER_BUILD_ARGS+=(
    --build-arg "OPENCLAW_CONFIG=${OPENCLAW_CONFIG_BUILD_PATH}"
    --build-arg "SOUL_PREAMBLE=${SOUL_PREAMBLE_BUILD_PATH}"
    --build-arg "PSD_RULES_SKILL=${PSD_RULES_BUILD_PATH}"
    --build-arg "OPENCLAW_BASE_IMAGE=${OPENCLAW_BASE_IMAGE}"
    --build-arg "BEDROCK_PLUGIN_VERSION=${BEDROCK_PLUGIN_VERSION}"
    --build-arg "BEDROCK_PLUGIN_EXPECTED_TOKEN=${BEDROCK_PLUGIN_EXPECTED_TOKEN}"
  )
fi
docker build "${DOCKER_BUILD_ARGS[@]}" "${SCRIPT_DIR}"
rm -f "${SCRIPT_DIR}/skills/validated-fs.cjs"

# ---------------------------------------------------------------------------
# Build-time eval gate (issue #1161): runtime boot probe + signed canary turn.
# The default native-SigV4 image never receives a provider secret. A Mantle
# candidate receives only the environment's secret ARN and resolves it inside
# the short-lived probe container. Every canary also requires the trusted web
# origin plus a short-lived router-signed invocation context AND its derived
# request-proof key — the web broker (/api/agent/model-proxy) authorizes on all
# three, and agentcore_wrapper.py refuses to install authority when either half
# of the pair is missing.
#
# Both halves are minted by scripts/agent-workspace/mint-agent-probe-context.ts
# (`bun run agent:probe-context`), which signs with the same HMAC key the router
# Lambda uses. This script auto-mints when the vars are unset and credentials
# allow it, so the gate runs by default instead of quietly degrading.
#
# A skipped runtime probe is a HARD FAILURE unless ALLOW_UNVERIFIED_IMAGE=1 is
# passed explicitly: "static gates passed" is not "the image boots", and an
# unverified image reaching ECR is exactly the outcome #1161 exists to prevent.
if [ "${SKIP_PROBE_GATE:-0}" = "1" ]; then
  echo ""
  echo "WARNING: SKIP_PROBE_GATE=1 — runtime boot/canary probe BYPASSED."
  echo "         This image is NOT boot-verified. See docs/operations/agent-image-build-gate.md"
else
  echo ""
  echo "=== Build-time eval gate (1161): runtime boot probe + canary turn ==="
  PROBE_APP_BASE_URL="${AGENT_PROBE_APP_BASE_URL:-}"
  PROBE_INVOCATION_CONTEXT="${AGENT_PROBE_INVOCATION_CONTEXT:-}"
  PROBE_REQUEST_PROOF_KEY="${AGENT_PROBE_REQUEST_PROOF_KEY:-}"

  PROBE_DIR="${PROBE_ARTIFACT_DIR:-${SCRIPT_DIR}/.build-probes}"
  mkdir -p "${PROBE_DIR}"
  PROBE_ARTIFACT="${PROBE_DIR}/${TAG}.json"

  # Auto-discovery 1: the broker origin. The router Lambda already holds the
  # exact APP_BASE_URL the deployed agent brokers through, so read it from
  # there rather than making every developer hardcode the environment's domain.
  if [ -z "${PROBE_APP_BASE_URL}" ]; then
    ROUTER_LAMBDA_ARN=$(aws cloudformation describe-stacks \
      --stack-name "${STACK_NAME}" \
      --query "Stacks[0].Outputs[?OutputKey=='RouterLambdaArn'].OutputValue" \
      --output text --region "${REGION}" 2>/dev/null || echo "")
    if [ -n "${ROUTER_LAMBDA_ARN}" ] && [ "${ROUTER_LAMBDA_ARN}" != "None" ]; then
      PROBE_APP_BASE_URL=$(aws lambda get-function-configuration \
        --function-name "${ROUTER_LAMBDA_ARN}" \
        --query 'Environment.Variables.APP_BASE_URL' \
        --output text --region "${REGION}" 2>/dev/null || echo "")
      [ "${PROBE_APP_BASE_URL}" = "None" ] && PROBE_APP_BASE_URL=""
      [ -n "${PROBE_APP_BASE_URL}" ] && \
        echo "  Broker origin (from router Lambda): ${PROBE_APP_BASE_URL}"
    fi
  fi

  # Auto-discovery 2: the signed context pair. Needs credentials that can read
  # psd-agent/<env>/invocation-signing-key — a developer has them, the AgentCore
  # execution role deliberately does not.
  if [ -z "${PROBE_INVOCATION_CONTEXT}" ] || [ -z "${PROBE_REQUEST_PROOF_KEY}" ]; then
    MINT_SCRIPT="${REPO_ROOT}/scripts/agent-workspace/mint-agent-probe-context.ts"
    if command -v bun >/dev/null 2>&1 && [ -r "${MINT_SCRIPT}" ]; then
      echo "  Minting a probe invocation context (bun run agent:probe-context)..."
      MINT_JSON=$(ENVIRONMENT="${ENVIRONMENT}" AWS_REGION="${REGION}" \
        bun run "${MINT_SCRIPT}" --json 2>&1) && MINT_STATUS=0 || MINT_STATUS=$?
      if [ "${MINT_STATUS}" -eq 0 ]; then
        # Parse tolerantly and on ONE line each: a non-JSON stdout (a bun
        # notice, say) must fall through to the actionable message below, not
        # abort the build via `set -e` on a failed command substitution.
        MINT_PAIR=$(printf '%s' "${MINT_JSON}" | "${PYTHON}" -c '
import json, sys
try:
    minted = json.loads(sys.stdin.read())
    print(minted["invocationContext"])
    print(minted["requestProofKey"])
except Exception:
    print(); print()' || printf '\n\n')
        PROBE_INVOCATION_CONTEXT=$(printf '%s\n' "${MINT_PAIR}" | sed -n 1p)
        PROBE_REQUEST_PROOF_KEY=$(printf '%s\n' "${MINT_PAIR}" | sed -n 2p)
        [ -n "${PROBE_INVOCATION_CONTEXT}" ] && echo "  Minted a fresh probe context."
      else
        echo "  Could not mint a probe context automatically:"
        printf '%s\n' "${MINT_JSON}" | tail -5 | sed 's/^/    /'
      fi
    else
      echo "  Skipping auto-mint (bun or ${MINT_SCRIPT} unavailable)."
    fi
  fi

  if [ -z "${PROBE_APP_BASE_URL}" ] || [ -z "${PROBE_INVOCATION_CONTEXT}" ] \
     || [ -z "${PROBE_REQUEST_PROOF_KEY}" ]; then
    MSG="runtime probe SKIPPED — no signed broker context, so the image is NOT boot-verified."
    echo "WARNING: ${MSG}" >&2
    echo "  To run the gate (see docs/operations/agent-image-build-gate.md):" >&2
    echo "    eval \"\$(bun run --silent agent:probe-context)\"" >&2
    echo "    export AGENT_PROBE_APP_BASE_URL=https://dev.<your-domain>" >&2
    echo "    ./build-and-push.sh ${TAG}" >&2
    echo "  To push an unverified image anyway, opt in explicitly:" >&2
    echo "    ALLOW_UNVERIFIED_IMAGE=1 ./build-and-push.sh ${TAG}" >&2
    printf '{"tag":"%s","skipped":true,"reason":"missing_signed_broker_context","allow_unverified":%s}\n' \
      "${TAG}" "$([ "${ALLOW_UNVERIFIED_IMAGE:-0}" = "1" ] && echo true || echo false)" \
      > "${PROBE_ARTIFACT}"
    # REQUIRE_PROBE_GATE=1 (CI) outranks ALLOW_UNVERIFIED_IMAGE, so an
    # inherited opt-in in the environment cannot weaken a pipeline.
    if [ "${REQUIRE_PROBE_GATE:-0}" = "1" ]; then
      echo "ERROR: REQUIRE_PROBE_GATE=1 but ${MSG}" >&2
      exit 1
    fi
    if [ "${ALLOW_UNVERIFIED_IMAGE:-0}" != "1" ]; then
      echo "ERROR: refusing to push an unverified image. ${MSG}" >&2
      exit 1
    fi
    echo "WARNING: ALLOW_UNVERIFIED_IMAGE=1 — pushing without boot verification." >&2
    PROBE_RAN="false"
  else
    PROBE_RAN="true"
    PROBE_TIMEOUT="${PROBE_BOOT_TIMEOUT:-120}"
    if [ -n "${CANDIDATE_ID}" ]; then
      CANARY_MESSAGE="${CANARY_MESSAGE:-Reply with exactly: CANDIDATE_OK}"
    else
      CANARY_MESSAGE="${CANARY_MESSAGE:-Reply with exactly: OK}"
    fi
    # The payload's user_email is identity metadata only — the broker derives
    # the real owner from the signed claims. Read it back OUT of the token so
    # the two can never disagree in logs, whoever minted the context.
    CANARY_OWNER_EMAIL=$("${PYTHON}" "${SCRIPT_DIR}/eval/probe.py" owner-email \
      "${PROBE_INVOCATION_CONTEXT}")
    echo "Starting probe container against the signed web broker..."
    # Pass through host AWS creds. Build an array (rather than unquoted
    # ${VAR:+...} word-splitting) so the args are robust regardless of the
    # credential alphabet / IFS.
    PROBE_ENV_ARGS=(-e "ENVIRONMENT=${ENVIRONMENT}" -e "AWS_REGION=${REGION}"
      -e "BUILD_MARKER=${TAG}@probe" -e "APP_BASE_URL=${PROBE_APP_BASE_URL}")
    if [ "${CANDIDATE_REQUIRES_BEARER}" = "true" ]; then
      BEDROCK_API_KEY_SECRET_ARN=$(aws cloudformation describe-stacks \
        --stack-name "${STACK_NAME}" \
        --query "Stacks[0].Outputs[?OutputKey=='BedrockApiKeySecretArn'].OutputValue" \
        --output text --region "${REGION}")
      if [ -z "${BEDROCK_API_KEY_SECRET_ARN}" ] \
         || [ "${BEDROCK_API_KEY_SECRET_ARN}" = "None" ]; then
        echo "ERROR: candidate uses Mantle but BedrockApiKeySecretArn is unavailable." >&2
        exit 1
      fi
      PROBE_ENV_ARGS+=(
        -e "BEDROCK_API_KEY_SECRET_ARN=${BEDROCK_API_KEY_SECRET_ARN}"
      )
    fi

    # The agent signs its own Bedrock calls with SigV4 from the AgentCore
    # execution role, so the probe container needs REAL credentials or the
    # canary turn cannot reach a model at all.
    #
    # Reading only AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN from the environment
    # is not enough and silently produced a useless gate: most developers (and
    # this repo's own docs) authenticate with a shared credentials file or an
    # SSO profile, where those variables are UNSET. The container then started
    # with no credentials and the canary failed with a generic
    # "I couldn't complete that", which looks identical to a real model bug.
    #
    # `aws configure export-credentials` resolves whatever the active chain is
    # — env vars, profile, SSO, assumed role — into the three variables the
    # container understands. Credentials are piped into the arg array and never
    # echoed; do not add a debug print here.
    if AWS_CREDS_ENV="$(aws configure export-credentials --format env-no-export 2>/dev/null)" \
       && [ -n "${AWS_CREDS_ENV}" ]; then
      while IFS= read -r cred_line; do
        case "${cred_line}" in
          AWS_ACCESS_KEY_ID=*|AWS_SECRET_ACCESS_KEY=*|AWS_SESSION_TOKEN=*)
            PROBE_ENV_ARGS+=(-e "${cred_line}")
            ;;
        esac
      done <<< "${AWS_CREDS_ENV}"
      unset AWS_CREDS_ENV
      echo "  Probe credentials: resolved from the active AWS credential chain."
    else
      # Fall back to the old behaviour so a CI runner that only exports the
      # variables still works.
      [ -n "${AWS_ACCESS_KEY_ID:-}" ] && PROBE_ENV_ARGS+=(-e "AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}")
      [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && PROBE_ENV_ARGS+=(-e "AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}")
      [ -n "${AWS_SESSION_TOKEN:-}" ] && PROBE_ENV_ARGS+=(-e "AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN}")
      echo "  Probe credentials: environment variables only (no credential chain)."
    fi
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
    # Both halves of the authority pair are mandatory: agentcore_wrapper.py's
    # _install_invocation_authority() rejects the turn outright when either the
    # signed context or its derived request-proof key is missing or malformed,
    # and the web broker verifies a per-request signature made with that key.
    CANARY_PAYLOAD=$("${PYTHON}" "${SCRIPT_DIR}/eval/probe.py" make-payload -- \
      "${CANARY_MESSAGE}" "${CANARY_OWNER_EMAIL}" \
      "${PROBE_INVOCATION_CONTEXT}" "${PROBE_REQUEST_PROOF_KEY}")
    CANARY_START=$(date +%s)
    CANARY_OUT=$(docker exec "${CID}" curl -sS -f -m "${CANARY_TIMEOUT}" \
      -X POST "http://127.0.0.1:8080/invocations" \
      -H "Content-Type: application/json" -d "${CANARY_PAYLOAD}" 2>&1) \
      && CANARY_STATUS=0 || CANARY_STATUS=$?
    CANARY_ELAPSED=$(( $(date +%s) - CANARY_START ))
    CANARY_ANSWER=$(printf '%s' "${CANARY_OUT}" | \
      "${PYTHON}" "${SCRIPT_DIR}/eval/probe.py" last-result)
    echo "    [canary] answer: ${CANARY_ANSWER:-<none>}"

    # Match the extracted answer with a word-bounded, case-SENSITIVE 'OK' — a
    # bare `grep -qi ok` false-passes on strings that merely CONTAIN the
    # substring ("token", "broken", "ExpiredTokenException", "look").
    if [ -n "${CANDIDATE_ID}" ]; then
      if [ "${CANARY_STATUS}" -eq 0 ] \
         && printf '%s' "${CANARY_ANSWER}" | grep -Eq '^CANDIDATE_OK[[:space:]]*$'; then
        CANARY_GRADED="true"
      else
        CANARY_GRADED="false"
      fi
    elif [ "${CANARY_STATUS}" -eq 0 ] \
         && printf '%s' "${CANARY_ANSWER}" | grep -Eq '(^|[^A-Za-z])OK([^A-Za-z]|$)'; then
      CANARY_GRADED="true"
    else
      CANARY_GRADED="false"
    fi
    if [ "${CANARY_GRADED}" = "true" ]; then
      echo "  Canary turn PASSED (answered in ${CANARY_ELAPSED}s)."
      CANARY_OK="true"
    else
      echo "ERROR: canary turn failed (exit=${CANARY_STATUS}) or missed the expected output." >&2
      printf '%s\n' "${CANARY_OUT}" | tail -5 | sed 's/^/    [canary-raw] /' >&2
      CANARY_OK="false"
    fi

    if [ -n "${CANDIDATE_ID}" ]; then
      printf '{"tag":"%s","candidate_id":"%s","boot_ok":true,"boot_elapsed_s":%s,"canary_ok":%s,"canary_elapsed_s":%s,"grader":"output_match","grade_passed":%s}\n' \
        "${TAG}" "${CANDIDATE_ID}" "${BOOT_ELAPSED}" "${CANARY_OK}" \
        "${CANARY_ELAPSED}" "${CANARY_GRADED}" > "${PROBE_ARTIFACT}"
    else
      printf '{"tag":"%s","boot_ok":true,"boot_elapsed_s":%s,"canary_ok":%s,"canary_elapsed_s":%s}\n' \
        "${TAG}" "${BOOT_ELAPSED}" "${CANARY_OK}" "${CANARY_ELAPSED}" \
        > "${PROBE_ARTIFACT}"
    fi
    echo "  Probe artifact: ${PROBE_ARTIFACT}"

    docker rm -f "${CID}" >/dev/null 2>&1 || true
    CID=""
    if [ "${CANARY_OK}" != "true" ]; then
      exit 1
    fi
  fi
  if [ "${PROBE_RAN}" = "true" ]; then
    echo "=== Eval gate PASSED — image is boot-verified and answers ==="
  else
    # Deliberately NOT the word "PASSED": the only way to reach this line is an
    # explicit ALLOW_UNVERIFIED_IMAGE=1, and the banner must read as the waiver
    # it is rather than as a green build.
    echo "=== Eval gate WAIVED — static checks only; image NOT boot-verified ==="
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

if [ -n "${CANDIDATE_ID}" ]; then
  CANDIDATE_SIDECAR="${SCRIPT_DIR}/.candidate-builds/${TAG}.json"
  "${PYTHON}" "${SCRIPT_DIR}/eval/candidates/candidate.py" finalize \
    --metadata "${CANDIDATE_METADATA}" \
    --out "${CANDIDATE_SIDECAR}" \
    --image "${ECR_URI}:${TAG}" \
    --digest "${DIGEST}" >/dev/null
  echo "Candidate metadata: ${CANDIDATE_SIDECAR}"
fi

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
