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
import json
import logging
import os
import re
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
from agent_failures import emit_agent_metric
from check_bootstrap_budget import check_runtime_bootstrap

# Runtime path OpenClaw reads its config + auto-loaded bootstrap files from.
# Same path hydrate_bedrock_api_key() inlines the bearer token into.
OPENCLAW_CONFIG_PATH = "/home/node/.openclaw/openclaw.json"
OPENCLAW_WORKSPACE_DIR = "/home/node/.openclaw"

# The model the agent platform runs on today — used as the last-resort model-id
# fallback for telemetry when neither the proxy, harness, nor caller supplied
# one. Must match the id the proxy records + an ai_models pricing row
# (migration 092); a mismatch silently yields $0 cost. Single source of truth so
# the two fallbacks below don't drift (issue #1083, review round 2).
# Switched GLM-5 -> Claude Sonnet 5 for #1089. Bedrock Mantle's Anthropic
# Messages endpoint echoes the bare `claude-sonnet-5` on the response (verified),
# so that is the id the proxy records — use it here too so the fallback matches.
DEFAULT_AGENT_MODEL_ID = "claude-sonnet-5"

adapter = OpenClawAdapter()

# Transparent logging proxy sitting between OpenClaw and Mantle.
# Track the process so we can reap it on shutdown and log if it crashes.
_mantle_proxy_process: subprocess.Popen | None = None


def _safe_header_value(value: str, limit: int = 100) -> str:
    """Strip characters that could break or forge the bracketed identity headers
    the system prompt parses (`[`, `]`, `\\r`, `\\n`) and cap the length. Every
    identity value interpolated into a header must go through this, so an
    attacker-controlled display name / email cannot inject a new header line
    (REV-COR-318)."""
    return re.sub(r'[\[\]\n\r]', '', value or '')[:limit]


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

def read_proxy_usage() -> dict:
    """Read cumulative token usage from the Mantle proxy's /usage endpoint
    (issue #1083). Returns a dict with input_tokens / output_tokens / model and
    an `ok` flag — `ok=False` (with zeros) when the proxy is unreachable / not
    answering, so the caller can tell "genuinely 0" from "read failed".

    The wrapper calls this immediately before and after adapter.process() and
    takes the delta — that sums a single turn's usage across all the Mantle
    sub-calls a tool loop makes, since the proxy is per-container = per-session
    and turns are serial. The `ok` flag matters for the BASELINE read: if the
    baseline failed (ok=False) we cannot trust the delta (final − 0 would
    over-count every prior turn), so the caller falls back to the harness
    numbers. Never raises: telemetry must never break a chat turn.
    """
    import urllib.request
    import urllib.error

    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:18791/usage", timeout=2
        ) as r:
            if r.status != 200:
                return {"input_tokens": 0, "output_tokens": 0,
                        "cache_read_input_tokens": 0, "cache_write_input_tokens": 0,
                        "usage_events": 0, "model": None, "ok": False}
            data = json.loads(r.read().decode("utf-8"))
        return {
            "input_tokens": int(data.get("input_tokens") or 0),
            "output_tokens": int(data.get("output_tokens") or 0),
            # Bedrock prompt-caching split (issue #1089). Older proxy images
            # (pre-#1089) omit these keys — default to 0 so a mixed rollout
            # never KeyErrors.
            "cache_read_input_tokens": int(data.get("cache_read_input_tokens") or 0),
            "cache_write_input_tokens": int(data.get("cache_write_input_tokens") or 0),
            # Per-turn model-call count (issue #1161). The proxy increments
            # usage_events once per adopted upstream response, so a before/after
            # delta = the number of Mantle round-trips this turn made. Older
            # proxy images omit the key — default to 0.
            "usage_events": int(data.get("usage_events") or 0),
            "model": data.get("model"),
            "ok": True,
        }
    except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
        logger.warning("read_proxy_usage failed: %s", str(exc)[:200])
        return {"input_tokens": 0, "output_tokens": 0,
                "cache_read_input_tokens": 0, "cache_write_input_tokens": 0,
                "usage_events": 0, "model": None, "ok": False}


# Track which workspace prefix this microVM is currently serving so we can
# (a) skip redundant S3 pulls and (b) push to the right prefix on shutdown.
_current_workspace_prefix: str | None = None

# Track which user the on-disk `gh` auth file is currently written for, so we
# only re-hit Secrets Manager when the invoking user changes within a microVM.
_current_gh_user: str | None = None


def hydrate_github_auth(user_email: str) -> None:
    """
    Write ~/.config/gh/hosts.yml so the `gh` CLI (baked into the image at
    /usr/local/bin/gh) is authenticated for the current invoking user.

    The `gh` binary persists across container restarts, but its auth state
    (normally written by `gh auth login`) does NOT — `~/.config/gh/` is
    ephemeral filesystem and not synced via workspace_sync. Skills that
    shell out to `gh` (notably the user-authored psd-github skill) hit
    "not authenticated" errors after every microVM cold-start.

    Setting GH_TOKEN in os.environ does not help here: OpenClaw is spawned
    once at container start with a frozen env snapshot, and skill
    subprocesses inherit that snapshot rather than the wrapper's current
    environment. Writing the on-disk config is the only mechanism that
    propagates to every gh invocation regardless of process tree.

    Per-user PAT location:
        psd-agent-creds/{ENVIRONMENT}/user/{user_email}/github_pat

    Non-fatal: many users don't have a PAT provisioned. Log and continue.
    """
    global _current_gh_user

    if not user_email or user_email == "unknown":
        return
    if user_email == _current_gh_user:
        return

    import boto3
    from botocore.exceptions import ClientError

    env = os.environ.get("ENVIRONMENT", "dev")
    secret_id = f"psd-agent-creds/{env}/user/{user_email}/github_pat"
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"

    try:
        # Avoid AWS_PROFILE leakage — same reason as hydrate_bedrock_api_key.
        saved_profile = os.environ.pop("AWS_PROFILE", None)
        try:
            sm = boto3.client("secretsmanager", region_name=region)
        finally:
            if saved_profile is not None:
                os.environ["AWS_PROFILE"] = saved_profile
        resp = sm.get_secret_value(SecretId=secret_id)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code == "ResourceNotFoundException":
            logger.info("No github_pat provisioned for %s — gh remains unauthenticated", user_email)
        else:
            logger.warning("gh hydrate ClientError for %s: %s", user_email, code)
        return
    except Exception as exc:  # noqa: BLE001
        logger.warning("gh hydrate failed for %s: %s", user_email, exc)
        return

    pat = (resp.get("SecretString") or "").strip()
    if not pat:
        logger.warning("github_pat secret for %s is empty", user_email)
        return

    gh_dir = "/home/node/.config/gh"
    hosts_path = os.path.join(gh_dir, "hosts.yml")
    try:
        os.makedirs(gh_dir, exist_ok=True)
        os.chmod(gh_dir, 0o700)
        # Minimal hosts.yml — `gh` will resolve the username via /user on demand.
        content = (
            "github.com:\n"
            f"    oauth_token: {pat}\n"
            "    git_protocol: https\n"
        )
        tmp_path = hosts_path + ".tmp"
        # Use os.open with O_CREAT|O_WRONLY|O_TRUNC and explicit 0600 mode so
        # the token never lands on disk readable by anyone but `node`.
        fd = os.open(tmp_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        try:
            os.write(fd, content.encode("utf-8"))
        finally:
            os.close(fd)
        os.replace(tmp_path, hosts_path)
    except OSError as exc:
        logger.warning("failed to write gh hosts.yml for %s: %s", user_email, exc)
        return

    _current_gh_user = user_email
    logger.info("gh auth hydrated for %s", user_email)


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

        # Inline the literal token into openclaw.json IF the config still
        # uses the token-authenticated mantle provider. The native
        # `amazon-bedrock` provider (#1138 native program) authenticates via
        # the aws-sdk credential chain (execution role) and has no apiKey
        # field — nothing to inline, and its absence is NOT an error. The
        # env var above stays hydrated either way (memorySearch's native
        # bedrock path consumes AWS_BEARER_TOKEN_BEDROCK).
        # BOOT-ABORT REGRESSION (2026-07-08, r10): this step used to
        # sys.exit(1) when amazon-bedrock-mantle was absent, which killed
        # every microVM boot after the provider switch (AgentCore 424
        # "error when starting"). Absent provider now logs and continues.
        config_path = "/home/node/.openclaw/openclaw.json"
        inlined = _inline_bearer_token(config_path, value)
        if inlined:
            logger.info(
                "Bedrock API key hydrated + inlined (secret=%s version=%s "
                "config=%s)",
                secret_arn.split(":")[-1], version, config_path,
            )
        else:
            logger.info(
                "Bedrock API key hydrated to env only (no token-auth "
                "provider in openclaw.json — native aws-sdk provider active)"
            )
    except Exception as exc:  # noqa: BLE001
        logger.error("failed to hydrate Bedrock API key: %s", exc)
        sys.exit(1)


def _inline_bearer_token(config_path: str, value: str) -> bool:
    """Inline the bearer token into the mantle provider's apiKey, if present.

    Returns True when a token-auth provider existed and was updated, False
    when the config has no `amazon-bedrock-mantle` provider (the native
    aws-sdk-auth provider path — nothing to inline). Config read/write
    errors are fatal: a half-written openclaw.json would break the gateway
    in stranger ways than a clean abort.
    """
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        providers = cfg.get("models", {}).get("providers", {})
        mantle = providers.get("amazon-bedrock-mantle")
        if not mantle:
            return False
        mantle["apiKey"] = value
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        return True
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("failed to inline API key into %s: %s", config_path, exc)
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


def _sanitize_header_field(value, max_len: int) -> str:
    """Strip prompt-header delimiters and clamp length.

    Attachment fields originate from user-controlled Chat data; re-sanitize
    here (the router also cleans them) so a crafted filename can neither break
    OUT of the [attachments: ...] header (brackets/newlines) nor SPOOF metadata
    within a `name="…"` field (double-quote / backslash) — e.g. a filename like
    `a" source="drive-link` forging a trusted driveFileId.
    """
    if not isinstance(value, str):
        return ""
    return re.sub(r'["\\\[\]\n\r]', "", value).strip()[:max_len]


def _attachment_workspace_paths(attachments) -> list:
    """Collect valid workspace-relative paths of router-fetched Chat uploads.

    Router-generated (`attachments/<stamp>-<idx>-<name>`), but treated as
    untrusted since the payload crosses a service boundary: only plain
    relative paths under attachments/ with a safe character set pass.
    workspace_sync.pull_files() re-validates against traversal independently.
    """
    if not isinstance(attachments, list):
        return []
    paths = []
    for att in attachments:
        if not isinstance(att, dict):
            continue
        path = att.get("workspacePath")
        if (
            isinstance(path, str)
            and path.startswith("attachments/")
            and ".." not in path
            and re.fullmatch(r"[A-Za-z0-9._/-]+", path)
        ):
            paths.append(path)
    return paths


def _render_attachments_header(attachments) -> str:
    """Render forwarded Chat attachments into a prompt header (issue #1138 F1).

    Tells the agent what arrived and how to reach it:
      - Chat uploads the router fetched carry `path="…"` — the file already
        exists in the workspace (pulled per-turn via workspace_sync.pull_files)
        and the agent reads it directly with its file tools.
      - Chat uploads WITHOUT a path failed to download — the agent should say
        so and ask the user to re-attach, never pretend the file is absent.
      - Drive files/chips are metadata-only by design (the Drive barrier):
        readable via the psd-workspace skill, subject to sharing with the
        agent account.
    """
    if not isinstance(attachments, list) or not attachments:
        return ""
    lines = []
    fetched = 0
    failed_uploads = 0
    for att in attachments:
        if not isinstance(att, dict):
            continue
        name = _sanitize_header_field(att.get("name"), 256) or "unnamed"
        mime = _sanitize_header_field(att.get("mimeType"), 100) or "unknown type"
        if att.get("source") == "drive-link":
            drive_id = _sanitize_header_field(att.get("driveFileId"), 256)
            loc = f' driveFileId="{drive_id}"' if drive_id else ""
            lines.append(
                f'- name="{name}" type="{mime}" source="drive-link"{loc}'
            )
        else:
            path = _sanitize_header_field(att.get("workspacePath"), 512)
            if path and path.startswith("attachments/"):
                fetched += 1
                lines.append(
                    f'- name="{name}" type="{mime}" source="chat-upload" '
                    f'path="/home/node/.openclaw/{path}"'
                )
            else:
                failed_uploads += 1
                lines.append(
                    f'- name="{name}" type="{mime}" source="chat-upload" '
                    f"(download failed — file NOT available)"
                )
    if not lines:
        return ""
    body = "\n".join(lines)
    guidance = []
    if fetched:
        guidance.append(
            "Files with a path= are already downloaded into your workspace — "
            "read them directly with your file tools at that path."
        )
    if failed_uploads:
        guidance.append(
            "Files marked download failed could not be retrieved — tell the "
            "user and ask them to re-attach."
        )
    guidance.append(
        "To read a Google Drive file or chip, use the psd-workspace skill "
        "(the file may need to be shared with your agent account first)."
    )
    return (
        f"[attachments: the user attached {len(lines)} file(s) to this "
        f"message]\n{body}\n"
        f"[{' '.join(guidance)}]"
    )


def _resolve_boot_model() -> tuple[bool, str, str]:
    """Verify the primary model resolves against the runtime openclaw.json.

    Reads agents.defaults.model.primary ("<provider>/<model-id>"), confirms the
    provider is registered under models.providers and the model id is one of its
    declared models, and that the provider's apiKey has been hydrated (no
    leftover "env:" placeholder) unless it's a native aws-sdk provider with no
    apiKey. Returns (ok, provider, model_id). Never raises — a resolution
    failure just means BOOT_OK is withheld and the dead-boot alarm fires.
    """
    try:
        with open(OPENCLAW_CONFIG_PATH, "r", encoding="utf-8") as fh:
            config = json.load(fh)
    except (OSError, ValueError) as exc:
        logger.error("BOOT: cannot read %s: %s", OPENCLAW_CONFIG_PATH, exc)
        return False, "unknown", "unknown"

    primary = (
        ((config.get("agents") or {}).get("defaults") or {}).get("model") or {}
    ).get("primary")
    if not isinstance(primary, str) or "/" not in primary:
        logger.error("BOOT: agents.defaults.model.primary missing/malformed: %r", primary)
        return False, "unknown", "unknown"

    provider_name, model_id = primary.split("/", 1)
    providers = (config.get("models") or {}).get("providers") or {}
    provider = providers.get(provider_name)
    if not isinstance(provider, dict):
        logger.error("BOOT: provider %r not registered in openclaw.json", provider_name)
        return False, provider_name, model_id

    model_ids = {m.get("id") for m in (provider.get("models") or []) if isinstance(m, dict)}
    if model_id not in model_ids:
        logger.error(
            "BOOT: model %r not declared under provider %r (declared=%s)",
            model_id, provider_name, sorted(i for i in model_ids if i),
        )
        return False, provider_name, model_id

    # Provider must have a usable credential: either the apiKey was hydrated
    # (no leftover "env:" placeholder) or it's a native provider with no apiKey
    # (aws-sdk credential chain). A dangling "env:" means hydration didn't run.
    api_key = provider.get("apiKey")
    if isinstance(api_key, str) and api_key.startswith("env:"):
        logger.error(
            "BOOT: provider %r apiKey still an unhydrated placeholder (%r)",
            provider_name, api_key,
        )
        return False, provider_name, model_id

    return True, provider_name, model_id


def verify_boot_and_emit_ok() -> bool:
    """Run the post-gateway boot verification and emit BOOT_OK on success.

    Called AFTER the gateway is confirmed ready. Verifies provider + model
    resolution, runs the runtime instruction-budget check (WARN + metric on
    over-budget bootstrap files — the r-weeks SOUL.md-truncation signature), and
    emits exactly one structured BOOT_OK line + a BootOk metric so the
    BUILD_MARKER-vs-BOOT_OK dead-boot alarm can confirm the microVM reached a
    serving state. Returns True when BOOT_OK was emitted.
    """
    # Runtime instruction-budget check — the build gate should have caught an
    # over-budget image, but a live truncation is a silent-degradation class we
    # alarm on directly (the AgentCore log group can't host a MetricFilter).
    violations = check_runtime_bootstrap(OPENCLAW_CONFIG_PATH, OPENCLAW_WORKSPACE_DIR)
    if violations:
        emit_agent_metric("BootTruncationWarn")
        for v in violations:
            logger.warning("BOOT_TRUNCATION: %s", v)

    ok, provider, model_id = _resolve_boot_model()
    if not ok:
        logger.error(
            "BOOT: model/provider resolution FAILED — withholding BOOT_OK "
            "(dead-boot alarm will fire). provider=%s model=%s",
            provider, model_id,
        )
        return False

    # Structured, single-line, greppable. The dead-boot MetricFilter/alarm keys
    # off the BootOk metric; this line is the human-readable confirmation.
    logger.info(
        "BOOT_OK provider=%s model=%s gateway_port=%s build=%s",
        provider, model_id, 3100, os.environ.get("BUILD_MARKER", "unset"),
    )
    emit_agent_metric("BootOk")
    return True


def main():
    """Start the AgentCore wrapper."""
    # Log the build marker FIRST so it appears even if startup fails. Emit a
    # matching BuildMarkerBoot metric so the BUILD_MARKER-vs-BOOT_OK divergence
    # alarm has a "a microVM booted" counter to compare BootOk against (the r10
    # dead-boot signature: booted but never reached a serving state).
    logger.info("BUILD_MARKER=%s", os.environ.get("BUILD_MARKER", "unset"))
    emit_agent_metric("BuildMarkerBoot")

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

        Yields events as a streaming response (text/event-stream). Async-
        generator entrypoints make BedrockAgentCoreApp emit SSE so bytes flow
        on the wire continuously — required for invocations that exceed the
        ~5-minute idle ceiling on buffered synchronous responses (the morning
        brief takes 4–8 minutes when it scans Chat / Gmail / Calendar).

        Stream contract:
          - first yield: {"type": "start"} — flushes headers immediately
          - heartbeats:  {"type": "heartbeat", "elapsed_s": int} every ~30s
          - final yield: {"result": "...", "metadata": {...}}

        Both the cron and router Lambdas discard heartbeat/start events and
        extract the final event's `result` field. See consumeAgentCoreStream()
        in infra/lambdas/agent-cron/index.ts and agent-router/index.ts.

        Expected payload keys (all optional except `prompt`):
            prompt                    — the user's text
            user_email                — caller's email (used as stable identity)
            user_display_name         — caller's display name for greetings
            workspace_prefix          — S3 prefix to mount as long-term memory
            model                     — optional model override
            invoked_by_email          — cross-user: email of the person consulting this agent
            invoked_by_display_name   — cross-user: display name of the invoker
            thread_context            — cross-user: ephemeral thread context from the Chat space
            attachments               — Chat files/Drive chips (issue #1138 F1):
                                        [{name, mimeType, source, driveFileId?,
                                          attachmentResourceName?}]
        """
        global _current_workspace_prefix

        session_id = getattr(context, "session_id", "unknown")
        user_message = payload.get("prompt", "")
        user_email = payload.get("user_email") or payload.get("user_id", "unknown")
        display_name = payload.get("user_display_name", "")
        workspace_prefix = payload.get("workspace_prefix", "")
        model_override = payload.get("model")
        # Optional turn-deadline override (async-job runner, #1138). Only the
        # job runner sends this; interactive router turns omit it and get the
        # 840s default. Non-int garbage degrades to None (default behavior).
        raw_deadline = payload.get("deadline_s")
        try:
            deadline_s = int(raw_deadline) if raw_deadline is not None else None
        except (TypeError, ValueError):
            deadline_s = None
        # Cross-user invocation fields
        invoked_by_email = payload.get("invoked_by_email", "")
        invoked_by_display_name = payload.get("invoked_by_display_name", "")
        thread_context = payload.get("thread_context", "")
        # Chat attachments / Drive chips the router forwarded (issue #1138 F1).
        attachments_header = _render_attachments_header(payload.get("attachments"))

        logger.info(
            "Invocation received: session=%s user=%s prefix=%s msg_length=%d "
            "cross_user=%s attachments=%d",
            session_id, user_email, workspace_prefix or "-", len(user_message),
            invoked_by_email or "no",
            len(payload.get("attachments") or []),
        )

        if not user_message.strip():
            yield {"result": "I didn't receive a message. Could you try again?"}
            return

        # Hydrate `gh` auth for the invoking user (no-op if same user, missing
        # PAT, or unknown identity). Runs every invocation cheaply because the
        # function short-circuits when _current_gh_user already matches.
        if user_email and user_email != "unknown":
            await asyncio.get_running_loop().run_in_executor(
                None, hydrate_github_auth, user_email
            )

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

        # Per-turn attachment delivery (issue #1138 F1): the router uploaded
        # Chat attachment bytes to S3 AFTER this microVM's one-time workspace
        # pull, so fetch exactly those keys now — the header below points the
        # agent at /home/node/.openclaw/<workspacePath> and the file must
        # exist there before the turn starts. Failures are non-fatal: the
        # agent still gets the metadata and reports the file as unavailable.
        attachment_paths = _attachment_workspace_paths(payload.get("attachments"))
        if attachment_paths and workspace_prefix:
            try:
                pulled = await asyncio.get_running_loop().run_in_executor(
                    None,
                    workspace_sync.pull_files,
                    workspace_prefix,
                    attachment_paths,
                )
                logger.info(
                    "attachments pulled: %d/%d", pulled, len(attachment_paths)
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("attachment pull failed: %s", exc)

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

        # Attachment header goes between the identity/time headers and the
        # user's message so the agent sees what arrived before reading the
        # request (issue #1138 F1). Empty when there are no attachments.
        attach_section = f"\n{attachments_header}" if attachments_header else ""

        # Cross-user invocation: when someone other than the agent owner
        # is consulting this agent, inject a [cross-user-invocation] header so
        # the system prompt can adjust behavior (consultation only, no task
        # execution). Thread context is ephemeral — not persisted to memory.
        # Sanitize every identity value that is interpolated into a bracketed
        # header, so an attacker-controlled display name / email cannot forge or
        # break a header line (REV-COR-318). The user_message body is NOT
        # sanitized — it is legitimate content, not header framing.
        safe_display = _safe_header_value(display_name)
        safe_email = _safe_header_value(user_email)
        safe_invoked_by_email = _safe_header_value(invoked_by_email)

        if invoked_by_email:
            safe_invoker_name = _safe_header_value(invoked_by_display_name or invoked_by_email)
            cross_user_header = (
                f"[cross-user-invocation: {safe_invoker_name} "
                f"<{safe_invoked_by_email}> is consulting you — this is NOT your owner. "
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
                f"[agent-owner: {safe_display or safe_email} <{safe_email}>]\n"
                f"{now_header}\n"
                f"{cross_user_header}{thread_section}{attach_section}\n\n"
                f"{user_message}"
            )
        elif display_name or user_email != "unknown":
            framed = (
                f"[caller: {safe_display or safe_email} <{safe_email}>]\n"
                f"{now_header}{attach_section}\n\n"
                f"{user_message}"
            )
        else:
            framed = f"{now_header}{attach_section}\n\n{user_message}"

        # Flush the SSE headers immediately. Without an early yield the SDK
        # waits for the first chunk before sending headers, defeating the
        # streaming purpose.
        invocation_start = time.time()
        yield {"type": "start", "session_id": session_id}

        loop = asyncio.get_running_loop()
        # Snapshot the proxy's cumulative usage BEFORE the turn so we can take a
        # delta afterward (issue #1083). The proxy is the ground-truth capture
        # point for GLM-5 token usage — OpenClaw's WS events don't surface it
        # reliably. Read in the executor so the (blocking) HTTP call doesn't
        # stall the event loop.
        #
        # ORDERING IS DELIBERATE — do NOT parallelize this baseline read with
        # process_task to shave latency (a tempting "optimization"). adapter.
        # process() drives Mantle calls that increment the proxy's cumulative
        # counter; if the baseline snapshot races those calls it captures part
        # of THIS turn's tokens, and `final − baseline` then under-counts. The
        # baseline must be fully read before process_task is scheduled.
        usage_baseline = await loop.run_in_executor(None, read_proxy_usage)
        process_task = loop.run_in_executor(
            None, adapter.process, framed, session_id, model_override,
            deadline_s,
        )

        # Heartbeat every 30s while adapter.process runs in the executor.
        # Each yield writes bytes to the SSE response, keeping the connection
        # alive past any infrastructure idle timeout.
        while True:
            try:
                result = await asyncio.wait_for(asyncio.shield(process_task), timeout=30)
                break
            except asyncio.TimeoutError:
                elapsed = int(time.time() - invocation_start)
                yield {"type": "heartbeat", "elapsed_s": elapsed}

        # Take the post-turn usage delta from the Mantle proxy (issue #1083).
        # This is the authoritative token source: the proxy reads every
        # OpenAI-compatible response's `usage` object, whereas the harness
        # adapter's WS-event extraction frequently yields 0. The proxy also
        # carries the real model id (e.g. "zai.glm-5") so we never record the
        # literal "default".
        #
        # The delta is only trustworthy when BOTH reads succeeded — if the
        # BASELINE read failed (ok=False), `final − 0` would over-count every
        # prior turn in this microVM, so we discard the proxy delta and fall
        # back to the harness numbers. The model id is still usable from a
        # successful final read regardless.
        usage_final = await loop.run_in_executor(None, read_proxy_usage)
        usage_trustworthy = usage_baseline.get("ok") and usage_final.get("ok")
        if usage_trustworthy:
            proxy_in = max(0, usage_final["input_tokens"] - usage_baseline["input_tokens"])
            proxy_out = max(0, usage_final["output_tokens"] - usage_baseline["output_tokens"])
            # Bedrock prompt-caching split (issue #1089) — same before/after
            # delta as input/output. Zero on GLM-5 (no caching) and any turn
            # with no cache activity.
            proxy_cache_read = max(0, usage_final["cache_read_input_tokens"]
                                   - usage_baseline["cache_read_input_tokens"])
            proxy_cache_write = max(0, usage_final["cache_write_input_tokens"]
                                    - usage_baseline["cache_write_input_tokens"])
            # Per-turn model-call count (issue #1161) — same before/after delta
            # as tokens. The proxy counts one usage_event per adopted upstream
            # response, so the delta is this turn's Mantle round-trip count.
            proxy_model_calls = max(0, usage_final["usage_events"]
                                    - usage_baseline["usage_events"])
        else:
            proxy_in = 0
            proxy_out = 0
            proxy_cache_read = 0
            proxy_cache_write = 0
            proxy_model_calls = 0
            # Emit a distinct signal so a telemetry GAP (proxy read failed) is
            # distinguishable in logs from a turn that genuinely used 0 tokens.
            # Without this, a lost read looks identical to real-zero usage.
            logger.warning(
                "proxy usage read degraded — falling back to harness tokens "
                "(baseline_ok=%s final_ok=%s session=%s)",
                usage_baseline.get("ok"), usage_final.get("ok"), session_id,
            )
        proxy_model = usage_final.get("model") if usage_final.get("ok") else None

        # Adapter contract: TurnResult preferred; legacy str still
        # accepted so older adapters keep working during a phased rollout.
        if isinstance(result, str):
            reply_text = result
            metadata: dict = {
                "session_id": session_id,
                "user_id": user_email,
                "model": proxy_model or model_override or DEFAULT_AGENT_MODEL_ID,
                "input_tokens": proxy_in,
                "output_tokens": proxy_out,
                # Cache tokens come only from the proxy delta (the harness has
                # no cache numbers), so they're 0 when the delta is untrusted.
                "cache_read_input_tokens": proxy_cache_read,
                "cache_write_input_tokens": proxy_cache_write,
                # Iteration telemetry (issue #1161). model_call_count from the
                # proxy delta; duration_ms is the full turn wall-clock. The
                # legacy-str adapter surfaces no nudge signal, so nudged=False.
                "model_call_count": proxy_model_calls,
                "duration_ms": int((time.time() - invocation_start) * 1000),
                "nudged": False,
            }
        else:
            reply_text = result.text or ""
            # Proxy delta wins; harness value is the fallback only when the
            # proxy read was itself untrustworthy (not merely when it measured
            # a real 0 — `or` would discard a trustworthy 0 and substitute the
            # harness's possibly-wrong count, contradicting this comment).
            input_tokens = proxy_in if usage_trustworthy else result.tokens_in
            output_tokens = proxy_out if usage_trustworthy else result.tokens_out
            metadata = {
                "session_id": session_id,
                "user_id": user_email,
                # Real model id, in priority order: proxy-observed > harness-
                # observed > caller override > the known default model. We
                # never emit the literal "default" anymore (issue #1083).
                "model": proxy_model or result.model or model_override or DEFAULT_AGENT_MODEL_ID,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                # Bedrock prompt-caching split (issue #1089). Proxy-only; 0 when
                # the proxy delta was untrusted or the model doesn't cache.
                "cache_read_input_tokens": proxy_cache_read if usage_trustworthy else 0,
                "cache_write_input_tokens": proxy_cache_write if usage_trustworthy else 0,
                # Iteration telemetry (issue #1161).
                # model_call_count: proxy delta when trustworthy, else 0 (the
                #   harness has no round-trip count, matching the token fallback).
                # duration_ms: full turn wall-clock in the wrapper — distinct
                #   from result.latency_ms (harness chat.send -> final); this
                #   also counts the proxy reads and the empty-turn nudge retry.
                # nudged: the harness fired its one empty-turn nudge this turn.
                "model_call_count": proxy_model_calls if usage_trustworthy else 0,
                "duration_ms": int((time.time() - invocation_start) * 1000),
                "nudged": result.nudged,
                "latency_ms": result.latency_ms,
                # Deep-telemetry payload: per-turn messages + tool calls.
                # The router reads these and inserts into
                # agent_message_content + agent_tool_invocations.
                "messages": result.messages,
                "tool_calls": result.tool_calls,
                # Error-turn signal (harness_adapter TurnResult.failed). The
                # router reads metadata.failed so a 0-token error turn (e.g. an
                # OpenClaw session-init conflict) is flagged, not logged as a
                # clean "Message processed" success. The harness already wrote
                # the agent_failures row for these.
                "failed": result.failed,
                "error_class": result.error_class,
            }

        logger.info(
            "Invocation complete: session=%s response_length=%d elapsed_s=%d "
            "model=%s tokens_in=%s tokens_out=%s tool_calls=%d "
            "model_calls=%s duration_ms=%s nudged=%s",
            session_id,
            len(reply_text),
            int(time.time() - invocation_start),
            metadata.get("model"),
            metadata.get("input_tokens"),
            metadata.get("output_tokens"),
            len(metadata.get("tool_calls") or []),
            metadata.get("model_call_count"),
            metadata.get("duration_ms"),
            metadata.get("nudged"),
        )

        yield {
            "result": reply_text,
            "metadata": metadata,
        }

    logger.info(
        "AgentCore wrapper starting — env=%s bucket=%s",
        os.environ.get("ENVIRONMENT", "unknown"),
        os.environ.get("WORKSPACE_BUCKET", "unknown"),
    )

    # Gateway is ready (adapter.configure blocked until /health 200), the
    # provider key is hydrated, and the proxy is healthy — verify model/provider
    # resolution and emit BOOT_OK. Best-effort: a verification failure withholds
    # BOOT_OK (surfaced by the dead-boot alarm) but must not stop the server
    # from trying to serve.
    try:
        verify_boot_and_emit_ok()
    except Exception as exc:  # noqa: BLE001
        logger.error("BOOT: verify_boot_and_emit_ok raised (continuing): %s", exc)

    app.run()


if __name__ == "__main__":
    main()
