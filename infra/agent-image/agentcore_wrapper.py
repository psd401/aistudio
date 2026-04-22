"""
AgentCore Wrapper — entrypoint that satisfies the Bedrock AgentCore Runtime
contract.

Flow on container start:
  1. Log BUILD_MARKER so CloudWatch proves which image is running
  2. Fetch the Bedrock API key from Secrets Manager and export it as
     AWS_BEARER_TOKEN_BEDROCK so OpenClaw can authenticate to Bedrock Mantle
     (the OpenAI-compatible endpoint)
  3. Start the OpenClaw gateway configured for Mantle — no local proxy
  4. Register the agent_invocation entrypoint with BedrockAgentCoreApp
  5. Route incoming payloads through the harness adapter via WebSocket

Environment variables (injected by AgentCore from the CDK stack):
  ENVIRONMENT                 — dev/staging/prod
  WORKSPACE_BUCKET            — S3 bucket for agent workspaces
  USERS_TABLE                 — DynamoDB table for user identity
  BEDROCK_API_KEY_SECRET_ARN  — Secrets Manager ARN holding the Bedrock
                                 API key (service-specific credential). CDK
                                 provisions + rotates this; we just read it
                                 on startup and forget about it.
  AWS_REGION                  — AWS region for the task role's SDK calls
  BUILD_MARKER                — `tag@sha256:…` of the deployed image

We intentionally no longer run a local Bedrock proxy. Mantle is AWS's
OpenAI-compatible Bedrock endpoint — OpenClaw speaks OpenAI natively, so
we point its provider config directly at Mantle. Killing the proxy also
kills the class of Converse format-translation bugs we used to own
(orphaned toolUse, parallel tool-result grouping, etc.).
"""

import asyncio
import logging
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

# Configure structured logging for CloudWatch
logging.basicConfig(
    level=logging.INFO,
    format='{"level":"%(levelname)s","message":"%(message)s","logger":"%(name)s","timestamp":"%(asctime)s"}',
    stream=sys.stdout,
    force=True,
)
logger = logging.getLogger("agentcore_wrapper")

from harness_adapter import OpenClawAdapter
import workspace_sync

adapter = OpenClawAdapter()

# Transparent logging proxy sitting between OpenClaw and Mantle.
# Track the process so we can reap it on shutdown and log if it crashes.
_mantle_proxy_process: subprocess.Popen | None = None


def start_mantle_proxy() -> None:
    """
    Launch the Mantle logging proxy on 127.0.0.1:18791 and block until
    /health returns 200. If it can't come up, exit — OpenClaw's openclaw.json
    points its baseUrl at the proxy, so no proxy means no model calls.
    """
    global _mantle_proxy_process
    import urllib.request
    import urllib.error

    logger.info("Starting Mantle logging proxy on 127.0.0.1:18791")
    _mantle_proxy_process = subprocess.Popen(
        [sys.executable, "/app/mantle_proxy.py"],
        stdout=sys.stdout,
        stderr=sys.stderr,
        env={**os.environ},
    )

    deadline = time.time() + 20
    while time.time() < deadline:
        if _mantle_proxy_process.poll() is not None:
            logger.error(
                "Mantle proxy exited during startup (rc=%s)",
                _mantle_proxy_process.returncode,
            )
            sys.exit(1)
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:18791/health", timeout=2
            ) as r:
                if r.status == 200:
                    logger.info("Mantle proxy is ready")
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.5)

    logger.error("Mantle proxy did not become ready within 20s")
    sys.exit(1)

# Track which workspace prefix this microVM is currently serving so we can
# (a) skip redundant S3 pulls and (b) push to the right prefix on shutdown.
_current_workspace_prefix: str | None = None


def hydrate_bedrock_api_key() -> None:
    """
    Fetch the Bedrock API key from Secrets Manager, export it as
    AWS_BEARER_TOKEN_BEDROCK, AND inline the literal value into
    openclaw.json's provider config.

    Why inline and not just env var: OpenClaw has (at least) two code paths
    that read the provider apiKey — the main chat pipeline and the
    embedded-agent runner used by plugins. In practice the embedded path
    has not been resolving `${AWS_BEARER_TOKEN_BEDROCK}` / `env:VAR` refs
    correctly in the installed gateway version, causing plugins (notably
    active-memory) to send an empty or literal-string bearer to Mantle and
    get HTTP 401 on every call. The embedded failure cascades to the main
    reply as `surface_error` on follow-up turns, breaking memory entirely.

    Writing the literal token into the on-disk config eliminates env-var
    resolution as a variable. The token is short-lived in the container FS
    (ephemeral microVM, no persistent storage for this path). We still
    export the env var for belt-and-suspenders and for any OpenClaw
    auto-discovery that reads it directly.

    Fails fast (SystemExit) if the secret is unreachable.
    """
    import boto3
    import json

    secret_arn = os.environ.get("BEDROCK_API_KEY_SECRET_ARN")
    if not secret_arn:
        logger.error("BEDROCK_API_KEY_SECRET_ARN env var is not set")
        sys.exit(1)

    try:
        # AWS_PROFILE may be set elsewhere to satisfy OpenClaw's pre-flight
        # auth-detection heuristic; pop it here so boto3 doesn't try to load
        # a (non-existent) profile file. Restored after the client is built.
        # AgentCore doesn't inject AWS_REGION, and secretsmanager requires
        # one. Default to us-east-1 (where this stack lives); make it
        # overridable via env for multi-region deployments.
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
        saved_profile = os.environ.pop("AWS_PROFILE", None)
        try:
            sm = boto3.client("secretsmanager", region_name=region)
        finally:
            if saved_profile is not None:
                os.environ["AWS_PROFILE"] = saved_profile

        resp = sm.get_secret_value(SecretId=secret_arn)
        value = resp.get("SecretString")
        if not value:
            logger.error("secret %s has empty SecretString", secret_arn)
            sys.exit(1)
        value = value.strip()
        if not value:
            logger.error("secret %s resolved to empty value after trimming", secret_arn)
            sys.exit(1)
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = value
        version = resp.get("VersionId", "?")

        # Inline the literal token into openclaw.json. OpenClaw rewrites
        # this file on gateway startup (see `Config overwrite` logs), but
        # it preserves the `apiKey` string as written. Substituting the
        # literal here means every OpenClaw code path that reads the
        # provider config — main pipeline, embedded runner, plugins —
        # sees an identical, already-resolved value.
        config_path = "/home/node/.openclaw/openclaw.json"
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            providers = cfg.get("models", {}).get("providers", {})
            mantle = providers.get("amazon-bedrock-mantle")
            if not mantle:
                logger.error(
                    "openclaw.json has no amazon-bedrock-mantle provider — "
                    "cannot inline token"
                )
                sys.exit(1)
            mantle["apiKey"] = value
            with open(config_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
            logger.info(
                "Bedrock API key hydrated + inlined (secret=%s version=%s "
                "config=%s)",
                secret_arn.split(":")[-1], version, config_path,
            )
        except (OSError, json.JSONDecodeError) as exc:
            logger.error("failed to inline API key into %s: %s", config_path, exc)
            sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        logger.error("failed to hydrate Bedrock API key: %s", exc)
        sys.exit(1)


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
    if _mantle_proxy_process and _mantle_proxy_process.poll() is None:
        _mantle_proxy_process.terminate()
        try:
            _mantle_proxy_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _mantle_proxy_process.kill()
    sys.exit(0)


signal.signal(signal.SIGTERM, handle_shutdown)
signal.signal(signal.SIGINT, handle_shutdown)


def main():
    """Start the AgentCore wrapper."""
    # Log the build marker FIRST so it appears even if startup fails.
    logger.info("BUILD_MARKER=%s", os.environ.get("BUILD_MARKER", "unset"))

    try:
        from bedrock_agentcore.runtime import BedrockAgentCoreApp
    except ImportError:
        logger.error(
            "bedrock_agentcore SDK not installed. "
            "Install via: pip install bedrock-agentcore"
        )
        sys.exit(1)

    # Step 1: hydrate the Bedrock API key for OpenClaw's Mantle provider.
    # This MUST happen before adapter.configure() because OpenClaw reads the
    # env var once at gateway start.
    hydrate_bedrock_api_key()

    # Step 1b: start the transparent Mantle proxy BEFORE OpenClaw. Its role
    # is purely diagnostic (logging every request + response to CloudWatch)
    # but it must be healthy first because OpenClaw's baseUrl points at it.
    start_mantle_proxy()

    # Step 2: start the OpenClaw gateway
    logger.info("Configuring OpenClaw adapter")
    adapter.configure({
        "gateway_port": 3100,
    })

    app = BedrockAgentCoreApp()

    @app.entrypoint
    async def agent_invocation(payload, context):
        """
        Handle an agent invocation from AgentCore.

        Expected payload keys (all optional except `prompt`):
            prompt                    — the user's text
            user_email                — caller's email (used as stable identity)
            user_display_name         — caller's display name for greetings
            workspace_prefix          — S3 prefix to mount as long-term memory
            model                     — optional model override
            invoked_by_email          — cross-user: email of the person consulting this agent (#903)
            invoked_by_display_name   — cross-user: display name of the invoker (#903)
            thread_context            — cross-user: ephemeral thread context from the Chat space (#903)
        """
        global _current_workspace_prefix

        session_id = getattr(context, "session_id", "unknown")
        user_message = payload.get("prompt", "")
        user_email = payload.get("user_email") or payload.get("user_id", "unknown")
        display_name = payload.get("user_display_name", "")
        workspace_prefix = payload.get("workspace_prefix", "")
        model_override = payload.get("model")
        # Cross-user invocation fields (#903)
        invoked_by_email = payload.get("invoked_by_email", "")
        invoked_by_display_name = payload.get("invoked_by_display_name", "")
        thread_context = payload.get("thread_context", "")

        logger.info(
            "Invocation received: session=%s user=%s prefix=%s msg_length=%d cross_user=%s",
            session_id, user_email, workspace_prefix or "-", len(user_message),
            invoked_by_email or "no",
        )

        if not user_message.strip():
            return {"result": "I didn't receive a message. Could you try again?"}

        # First invocation for a new workspace prefix → pull memory from S3.
        if workspace_prefix and workspace_prefix != _current_workspace_prefix:
            try:
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

        # Inject per-turn context: the caller's identity AND the current
        # Pacific local time. The LLM has no real clock — without this header
        # it falls back to whatever timestamps it sees in system metadata
        # (container clock is UTC) and confidently reports the wrong date.
        # PSD is in Washington State so America/Los_Angeles applies to every
        # caller. If we ever serve users outside this TZ, we'd switch to a
        # per-user preference — for now, hard-coded is correct for everyone.
        pacific_now = datetime.now(ZoneInfo("America/Los_Angeles"))
        now_header = (
            f"[now: {pacific_now.strftime('%A, %B %d, %Y %-I:%M %p')} "
            f"Pacific ({pacific_now.strftime('%Y-%m-%dT%H:%M:%S%z')})]"
        )

        # Cross-user invocation (#903): when someone other than the agent owner
        # is consulting this agent, inject a [cross-user-invocation] header so
        # the system prompt can adjust behavior (consultation only, no task
        # execution). Thread context is ephemeral — not persisted to memory.
        if invoked_by_email:
            cross_user_header = (
                f"[cross-user-invocation: {invoked_by_display_name or invoked_by_email} "
                f"<{invoked_by_email}> is consulting you — this is NOT your owner. "
                f"Answer questions and provide information, but do NOT execute tasks, "
                f"modify files, draft emails, or take actions on your owner's behalf.]"
            )
            thread_section = ""
            if thread_context:
                thread_section = (
                    f"\n\n[thread-context: The following is the recent conversation "
                    f"from the Google Chat space. This is ephemeral context — do NOT "
                    f"save it to your memory files.]\n{thread_context}\n"
                    f"[end-thread-context]"
                )
            framed = (
                f"[caller: {display_name or user_email} <{user_email}>]\n"
                f"{now_header}\n"
                f"{cross_user_header}{thread_section}\n\n"
                f"{user_message}"
            )
        elif display_name or user_email != "unknown":
            framed = (
                f"[caller: {display_name or user_email} <{user_email}>]\n"
                f"{now_header}\n\n"
                f"{user_message}"
            )
        else:
            framed = f"{now_header}\n\n{user_message}"

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None, adapter.process, framed, session_id, model_override
        )

        logger.info(
            "Invocation complete: session=%s response_length=%d",
            session_id, len(result),
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

    app.run()


if __name__ == "__main__":
    main()
