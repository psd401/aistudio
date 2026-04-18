"""
AgentCore Wrapper — Entrypoint that satisfies the Bedrock AgentCore Runtime contract.

Architecture (based on aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore):
1. Starts the Bedrock proxy (OpenAI → Bedrock ConverseStream adapter) on port 18790
2. Starts the OpenClaw gateway (connects to proxy as its model provider)
3. Registers the agent_invocation entrypoint with BedrockAgentCoreApp
4. Routes incoming payloads through the harness adapter via WebSocket

Environment variables (injected by AgentCore from CDK stack):
  ENVIRONMENT          — dev/staging/prod
  WORKSPACE_BUCKET     — S3 bucket for agent workspaces
  USERS_TABLE          — DynamoDB table for user identity
  AWS_PROFILE          — Set to 'default' so OpenClaw auth gate passes
  AWS_REGION           — AWS region for Bedrock API calls
"""

import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
import time

# Configure structured logging for CloudWatch
logging.basicConfig(
    level=logging.INFO,
    format='{"level":"%(levelname)s","message":"%(message)s","logger":"%(name)s","timestamp":"%(asctime)s"}',
    stream=sys.stdout,
    force=True,
)
logger = logging.getLogger("agentcore_wrapper")

# Import the harness adapter
from harness_adapter import OpenClawAdapter

# Initialize the adapter
adapter = OpenClawAdapter()

# Track the proxy process for cleanup
proxy_process = None


def start_bedrock_proxy():
    """Start the Bedrock proxy server (OpenAI → Bedrock ConverseStream)."""
    global proxy_process
    logger.info("Starting Bedrock proxy on port 18790")
    proxy_process = subprocess.Popen(
        ["node", "/opt/bedrock-proxy/bedrock-proxy.js"],
        stdout=sys.stdout,
        stderr=sys.stderr,
        env={**os.environ},
    )

    # Wait for proxy to be ready
    import urllib.request
    import urllib.error

    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            req = urllib.request.Request("http://127.0.0.1:18790/health")
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status == 200:
                    logger.info("Bedrock proxy is ready")
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.5)

    raise RuntimeError("Bedrock proxy did not become ready within 15s")


def handle_shutdown(signum, frame):
    """Graceful shutdown on SIGTERM/SIGINT."""
    logger.info("Received signal %d, shutting down", signum)
    adapter.shutdown()
    if proxy_process and proxy_process.poll() is None:
        proxy_process.terminate()
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

    # Step 1: Start the Bedrock proxy (translates OpenAI format → Bedrock API)
    # This must start before OpenClaw so the gateway can connect to it.
    start_bedrock_proxy()

    # Step 2: Start the OpenClaw gateway (uses proxy as its model provider)
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
            "Invocation received: session=%s user=%s msg_length=%d",
            session_id,
            user_id,
            len(user_message),
        )

        if not user_message.strip():
            return {"result": "I didn't receive a message. Could you try again?"}

        # Process through the harness — offload blocking WebSocket I/O to a thread
        # to avoid blocking the async event loop.
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None, adapter.process, user_message, session_id, model_override
        )

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
