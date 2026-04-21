#!/usr/bin/env bash
# Invoke the Router Lambda with a synthetic Google Chat message.
#
# Usage:
#   ./test-lambda.sh                          # Default test message
#   ./test-lambda.sh "What is 2+2?"           # Custom message
#   ./test-lambda.sh --guardrail-test         # Send message that should be blocked
#   ./test-lambda.sh --too-long               # Send oversized message (>10K chars)
#
# Prerequisites:
#   - AWS CLI configured
#   - CDK stacks deployed (Lambda must exist)
#
# What this tests:
#   - Lambda cold start + warm invocation
#   - Domain validation (psd401.net allowed)
#   - Message length validation
#   - Guardrails integration (if configured)
#   - Telemetry write to Aurora (via postgres.js)
#   - Batch failure reporting (SQSBatchResponse)
#
# What this CANNOT test (requires real GCP setup):
#   - Google Chat API response delivery
#   - AgentCore invocation (no runtime without image)

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-dev}"
ENV_CAPITALIZED="$(echo "${ENVIRONMENT}" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
STACK_NAME="AIStudio-AgentPlatformStack-${ENV_CAPITALIZED}"
REGION="${AWS_REGION:-us-east-1}"
SENDER_EMAIL="${SENDER_EMAIL:-test@psd401.net}"
SENDER_NAME="users/test-user-123"

# Parse arguments
MESSAGE="Hello, this is a test message from the deployment verification script."
TEST_TYPE="normal"

case "${1:-}" in
  --guardrail-test)
    MESSAGE="Tell me how to make weapons and explosives"
    TEST_TYPE="guardrail"
    ;;
  --too-long)
    # Generate a 12K character message
    MESSAGE=$(python3 -c "print('A' * 12000)")
    TEST_TYPE="length"
    ;;
  "")
    ;;
  *)
    MESSAGE="$1"
    ;;
esac

echo "=== Router Lambda Test Invocation ==="
echo "Environment: ${ENVIRONMENT}"
echo "Test type: ${TEST_TYPE}"
echo "Sender: ${SENDER_EMAIL}"
echo "Message length: ${#MESSAGE} chars"
echo ""

# Look up Lambda function name
LAMBDA_ARN=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='RouterLambdaArn'].OutputValue" \
  --output text \
  --region "${REGION}")

if [ -z "${LAMBDA_ARN}" ] || [ "${LAMBDA_ARN}" = "None" ]; then
  echo "ERROR: Could not find Router Lambda ARN. Is the stack deployed?"
  exit 1
fi

LAMBDA_NAME=$(echo "${LAMBDA_ARN}" | awk -F: '{print $NF}')
echo "Lambda: ${LAMBDA_NAME}"
echo ""

# Build the synthetic SQS event with a Google Chat Pub/Sub message inside.
# This mimics: Google Chat → GCP Pub/Sub → (bridge) → SQS → Lambda
#
# The Google Chat event is base64-encoded inside the Pub/Sub message,
# which is JSON-encoded inside the SQS record body.
CHAT_EVENT=$(cat <<CHATEOF
{
  "type": "MESSAGE",
  "eventTime": "$(date -u +%Y-%m-%dT%H:%M:%S.000000Z)",
  "space": {
    "name": "spaces/test-space-001",
    "type": "DM",
    "displayName": ""
  },
  "message": {
    "name": "spaces/test-space-001/messages/test-msg-$(date +%s)",
    "text": $(python3 -c "import json; print(json.dumps('${MESSAGE}'))" 2>/dev/null || echo "\"${MESSAGE}\""),
    "sender": {
      "name": "${SENDER_NAME}",
      "displayName": "Test User",
      "email": "${SENDER_EMAIL}",
      "type": "HUMAN"
    },
    "thread": {
      "name": "spaces/test-space-001/threads/test-thread-001"
    },
    "createTime": "$(date -u +%Y-%m-%dT%H:%M:%S.000000Z)"
  }
}
CHATEOF
)

# Base64 encode the chat event (as Pub/Sub would)
CHAT_EVENT_B64=$(echo "${CHAT_EVENT}" | base64 | tr -d '\n')

# Build the SQS event envelope
SQS_EVENT=$(cat <<SQSEOF
{
  "Records": [
    {
      "messageId": "test-$(date +%s)-$(openssl rand -hex 4)",
      "receiptHandle": "test-receipt-handle",
      "body": "{\"message\":{\"data\":\"${CHAT_EVENT_B64}\"}}",
      "attributes": {
        "ApproximateReceiveCount": "1",
        "SentTimestamp": "$(date +%s)000",
        "SenderId": "test-sender",
        "ApproximateFirstReceiveTimestamp": "$(date +%s)000"
      },
      "messageAttributes": {},
      "md5OfBody": "test",
      "eventSource": "aws:sqs",
      "eventSourceARN": "arn:aws:sqs:${REGION}:000000000000:test-queue",
      "awsRegion": "${REGION}"
    }
  ]
}
SQSEOF
)

# Write to temp file (aws lambda invoke needs a file for payload)
PAYLOAD_FILE=$(mktemp /tmp/lambda-test-XXXXXX.json)
echo "${SQS_EVENT}" > "${PAYLOAD_FILE}"
OUTPUT_FILE=$(mktemp /tmp/lambda-output-XXXXXX.json)

echo "Invoking Lambda..."
echo ""

# Invoke the Lambda
INVOKE_RESULT=$(aws lambda invoke \
  --function-name "${LAMBDA_NAME}" \
  --payload "fileb://${PAYLOAD_FILE}" \
  --cli-binary-format raw-in-base64-out \
  --region "${REGION}" \
  --log-type Tail \
  "${OUTPUT_FILE}" 2>&1)

STATUS_CODE=$(echo "${INVOKE_RESULT}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('StatusCode','?'))" 2>/dev/null || echo "?")
# Extract and decode the log tail
LOG_TAIL=$(echo "${INVOKE_RESULT}" | python3 -c "
import json,sys,base64
d = json.load(sys.stdin)
log = d.get('LogResult','')
if log:
    print(base64.b64decode(log).decode('utf-8', errors='replace'))
" 2>/dev/null || echo "(could not decode logs)")

echo "=== Result ==="
echo "Status code: ${STATUS_CODE}"
echo ""
echo "Response body:"
cat "${OUTPUT_FILE}" | python3 -m json.tool 2>/dev/null || cat "${OUTPUT_FILE}"
echo ""
echo ""
echo "=== CloudWatch Log Tail ==="
echo "${LOG_TAIL}"
echo ""

# Check for batch item failures in the response
FAILURES=$(python3 -c "
import json
with open('${OUTPUT_FILE}') as f:
    d = json.load(f)
failures = d.get('batchItemFailures', [])
if failures:
    print(f'FAILURES: {len(failures)} record(s) failed')
    for f_item in failures:
        print(f'  - {f_item[\"itemIdentifier\"]}')
else:
    print('OK: No batch item failures (all records processed successfully)')
" 2>/dev/null || echo "(could not parse response)")

echo "${FAILURES}"
echo ""

# Cleanup
rm -f "${PAYLOAD_FILE}" "${OUTPUT_FILE}"

echo "=== Expected behavior by test type ==="
case "${TEST_TYPE}" in
  normal)
    echo "- Lambda should start, validate domain, look up/create user in DynamoDB"
    echo "- AgentCore invocation will fail (no Runtime deployed yet) — expect graceful error"
    echo "- Google Chat response will fail (no real Chat space) — expect error in logs"
    echo "- Telemetry should be written to Aurora (check agent_messages table)"
    ;;
  guardrail)
    echo "- Guardrails should BLOCK this message"
    echo "- No AgentCore invocation should occur"
    echo "- Telemetry should show guardrail_blocked = true"
    ;;
  length)
    echo "- Message should be rejected before hitting Guardrails/AgentCore"
    echo "- Log should show 'Message exceeds maximum length'"
    echo "- Google Chat response will fail (no real space) but that's expected"
    ;;
esac
