"""
AgentCore Wrapper — Entrypoint that satisfies the Bedrock AgentCore Runtime contract.

This wrapper:
1. Starts the OpenClaw harness in the background
2. Registers the agent_invocation entrypoint with BedrockAgentCoreApp
3. Routes incoming payloads through the harness adapter
4. Returns structured responses to AgentCore

Environment variables (injected by AgentCore from CDK stack):
  ENVIRONMENT          — dev/staging/prod
  WORKSPACE_BUCKET     — S3 bucket for agent workspaces
  USERS_TABLE          — DynamoDB table for user identity
  SIGNALS_TABLE        — DynamoDB table for organizational signals
  GUARDRAIL_ARN        — Bedrock Guardrail ARN for content filtering
  DATABASE_RESOURCE_ARN — Aurora cluster ARN for telemetry
  DATABASE_SECRET_ARN  — Aurora credentials secret ARN
"""

import json
import logging
import os
import signal
import sys

# Configure structured logging for CloudWatch
logging.basicConfig(
    level=logging.INFO,
    format='{"level":"%(levelname)s","message":"%(message)s","logger":"%(name)s","timestamp":"%(asctime)s"}',
    stream=sys.stdout,
)
logger = logging.getLogger("agentcore_wrapper")

# Import the harness adapter
from harness_adapter import OpenClawAdapter

# Initialize the adapter
adapter = OpenClawAdapter()


def handle_shutdown(signum, frame):
    """Graceful shutdown on SIGTERM/SIGINT."""
    logger.info("Received signal %d, shutting down", signum)
    adapter.shutdown()
    sys.exit(0)


signal.signal(signal.SIGTERM, handle_shutdown)
signal.signal(signal.SIGINT, handle_shutdown)


def main():
    """Start the AgentCore wrapper."""
    try:
        from bedrock_agentcore.runtime import BedrockAgentCoreApp
    except ImportError:
        logger.error(
            "bedrock_agentcore SDK not installed. "
            "Install via: pip install bedrock-agentcore"
        )
        sys.exit(1)

    # Configure and start the OpenClaw harness
    logger.info("Configuring OpenClaw adapter")
    adapter.configure({
        "gateway_port": 3100,
    })

    # Create the AgentCore app
    app = BedrockAgentCoreApp()

    @app.entrypoint
    async def agent_invocation(payload, context):
        """
        Handle an agent invocation from AgentCore.

        Args:
            payload: dict with at minimum a "prompt" key containing the user message
            context: AgentCore runtime context with session_id attribute
        """
        session_id = getattr(context, "session_id", "unknown")
        user_message = payload.get("prompt", "")
        user_id = payload.get("user_id", "unknown")
        model_override = payload.get("model")

        logger.info(
            "Invocation received: session=%s user=%s model_override=%s msg_length=%d",
            session_id,
            user_id,
            model_override,
            len(user_message),
        )

        if not user_message.strip():
            return {"result": "I didn't receive a message. Could you try again?"}

        # If a model override is specified, configure it before processing
        if model_override:
            adapter.configure({"model": model_override})

        # Process through the harness
        result = adapter.process(user_message, session_id)

        logger.info(
            "Invocation complete: session=%s response_length=%d",
            session_id,
            len(result),
        )

        return {
            "result": result,
            "metadata": {
                "session_id": session_id,
                "user_id": user_id,
                "model": model_override or "default",
            },
        }

    logger.info(
        "AgentCore wrapper starting — env=%s bucket=%s",
        os.environ.get("ENVIRONMENT", "unknown"),
        os.environ.get("WORKSPACE_BUCKET", "unknown"),
    )

    # Run the AgentCore app (blocks until shutdown)
    app.run()


if __name__ == "__main__":
    main()
