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
import workspace_sync

# Initialize the adapter
adapter = OpenClawAdapter()

# Track the proxy process for cleanup
proxy_process = None

# Track which workspace prefix this microVM is currently serving so we can
# (a) skip redundant S3 pulls and (b) push to the right prefix on shutdown.
_current_workspace_prefix: str | None = None


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
    """Graceful shutdown on SIGTERM/SIGINT — push workspace to S3 first."""
    logger.info("Received signal %d, shutting down", signum)
    workspace_sync.stop_periodic_push()
    if _current_workspace_prefix:
        try:
            workspace_sync.push_workspace(_current_workspace_prefix)
        except Exception as exc:  # noqa: BLE001
            logger.warning("shutdown workspace push failed: %s", exc)
    adapter.shutdown()
    if proxy_process and proxy_process.poll() is None:
        proxy_process.terminate()
    sys.exit(0)


signal.signal(signal.SIGTERM, handle_shutdown)
signal.signal(signal.SIGINT, handle_shutdown)


def main():
    """Start the AgentCore wrapper."""
    # Log the build marker FIRST so it appears even if startup fails. This is
    # the only reliable way to confirm AgentCore is running the deployed image.
    logger.info("BUILD_MARKER=%s", os.environ.get("BUILD_MARKER", "unset"))

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

        Expected payload keys (all optional except `prompt`):
            prompt             — the user's text
            user_email         — caller's email (used as stable identity)
            user_display_name  — caller's display name for greetings
            workspace_prefix   — S3 prefix to mount as long-term memory
            model              — optional model override
        """
        global _current_workspace_prefix

        session_id = getattr(context, "session_id", "unknown")
        user_message = payload.get("prompt", "")
        user_email = payload.get("user_email") or payload.get("user_id", "unknown")
        display_name = payload.get("user_display_name", "")
        workspace_prefix = payload.get("workspace_prefix", "")
        model_override = payload.get("model")

        logger.info(
            "Invocation received: session=%s user=%s prefix=%s msg_length=%d",
            session_id,
            user_email,
            workspace_prefix or "-",
            len(user_message),
        )

        if not user_message.strip():
            return {"result": "I didn't receive a message. Could you try again?"}

        # First invocation for a new workspace prefix → pull memory from S3.
        # Subsequent invocations on this microVM reuse the already-mounted state.
        if workspace_prefix and workspace_prefix != _current_workspace_prefix:
            try:
                # Run blocking S3 calls off the event loop
                pulled = await asyncio.get_running_loop().run_in_executor(
                    None, workspace_sync.pull_workspace, workspace_prefix
                )
                logger.info(
                    "workspace mounted: prefix=%s files=%d",
                    workspace_prefix, pulled,
                )
                _current_workspace_prefix = workspace_prefix
                workspace_sync.start_periodic_push(workspace_prefix, interval_s=120)
            except Exception as exc:  # noqa: BLE001
                logger.warning("workspace mount failed: %s", exc)

        # Inject a brief identity preamble so the agent always knows who is
        # speaking (the system prompt alone can't carry per-request identity).
        # Kept minimal — the agent's own SOUL.md handles persona/style.
        if display_name or user_email != "unknown":
            framed = (
                f"[caller: {display_name or user_email} <{user_email}>]\n\n"
                f"{user_message}"
            )
        else:
            framed = user_message

        # Process through the harness — offload blocking WebSocket I/O to a thread
        # to avoid blocking the async event loop.
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None, adapter.process, framed, session_id, model_override
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
                "user_id": user_email,
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
