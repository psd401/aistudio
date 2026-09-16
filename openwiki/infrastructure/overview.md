---
type: Infrastructure Overview
title: AWS CDK Infrastructure
description: AWS CDK infrastructure with ECS Fargate, Aurora Serverless v2, Cognito authentication, and modular construct library for K-12 AI platform deployment.
tags: [infrastructure, cdk, aws, deployment, ecs]
openwiki:
  roles: [infrastructure, operations]
  source_paths:
    - Dockerfile.graviton
    - infra/test/agent-skill-cdn-allowlist.test.ts
    - infra/test/atrium-sandbox-csp.test.ts
    - infra/lib/atrium-sandbox-stack.ts
    - infra/agent-image/check_config_consistency.py
  test_paths:
    - infra/test/agent-skill-cdn-allowlist.test.ts
    - infra/agent-image/test_check_config_consistency.py
---

# Infrastructure

AI Studio is deployed on AWS using CDK (Cloud Development Kit) with TypeScript. The infrastructure prioritizes security, cost optimization, and educational compliance requirements.

## Overview

**IaC Tool**: AWS CDK v2
**Location**: `/infra/`

### Deployment Commands

```bash
cd infra && bunx cdk deploy --all                          # Deploy all stacks
cd infra && bunx cdk deploy AIStudio-FrontendStack-Dev     # Deploy single stack
cd infra && bunx cdk diff                                  # Preview changes
```

---

## Stack Architecture

### Core Stacks

| Stack | Purpose |
|-------|---------|
| `FrontendStack` | Next.js SSR on ECS Fargate |
| `ProcessingStack` | Lambda functions for async work |
| `AgentPlatformStack` | Agent infrastructure (skills, mint Lambda) |
| `DatabaseStack` | Aurora Serverless v2 cluster |

### Stack Dependencies

Defined in `/infra/lib/stacks/`, stacks are deployed in order based on SSM parameter flows:

```
NetworkStack → DatabaseStack → ProcessingStack → FrontendStack
                             ↘ AgentPlatformStack
```

See `/docs/diagrams/01-cdk-stack-dependencies.md` for visual diagram.

---

## Reusable Constructs

**Location**: `/infra/lib/constructs/`

CDK constructs provide consistent, secure patterns:

### Security Constructs
- `/security/` — IAM roles, policies, secrets management
- Cedar policy enforcement via `/infra/policies/cedar/`

### Network Constructs
- `/network/` — VPC, subnets, security groups, VPC endpoints
- Multi-AZ deployment with isolated subnets

### Compute Constructs
- `/compute/` — Lambda, ECS patterns
- Hyperframes render function for video generation

### Monitoring Constructs
- `/monitoring/` — CloudWatch dashboards, alarms, ADOT

### Configuration Constructs
- `/config/` — Environment-specific settings

---

## ECS Fargate (Frontend)

### Configuration

**Next.js 16 SSR** deployed on ECS Fargate with:
- Application Load Balancer
- Auto-scaling based on CPU/memory
- Run tasks for streaming responses

### Container Definition

| File | Purpose |
|------|---------|
| `/Dockerfile` | Production container |
| `/Dockerfile.dev` | Development container |
| `/Dockerfile.graviton` | ARM64 support |
| `/infra/lib/constructs/ecs-service.ts` | Service definition |

#### ARM64 Build Requirements

**Source**: `/Dockerfile.graviton` lines 19–31

The Graviton (ARM64) Dockerfile requires a capped network concurrency for `bun install` to prevent build failures:

```bash
bun install --frozen-lockfile --network-concurrency 8
```

**Why this is required**: At the default concurrency (48), ARM64 builds inside Docker fail intermittently with tarball integrity errors on different packages each run (e.g., sharp, mermaid). The `--network-concurrency 8` flag prevents parallel fetch truncation that surfaces as:

- `Integrity check failed for tarball: sharp`
- `Fail extracting tarball for mermaid`

**Root cause**: Bun's parallel fetch under high concurrency causes tarball truncation inside Docker builds. This was isolated by ruling out lockfile integrity, VM disk space, network issues, memory, and disk I/O.

**Critical**: This flag is load-bearing, not tuning. Removing it will cause inconsistent ARM64 builds even when the same lockfile installs successfully on the host.

### Auto-Pause (Dev)

Dev environments scale to 0 when idle, saving ~$44/month:
- Min capacity: 0 (dev), 2 (prod)
- No cold start for prod
- Configured via Aurora and ECS task scaling

---

## Aurora Serverless v2

### Cluster Configuration

| Environment | Min ACU | Max ACU | Auto-Pause |
|-------------|---------|---------|------------|
| **Dev** | 0 | 4 | Yes |
| **Prod** | 2 | 8 | No |

### Connection Management

- PostgreSQL driver with connection pooling
- Max 20 connections per container
- 20s idle timeout
- Graceful shutdown via `/instrumentation.ts`

### Backups

- Automated daily snapshots
- 7-day retention (dev), 30-day (prod)

### Migrations

Migrations run via Lambda function:
1. Read from `/infra/database/migrations.json`
2. Execute SQL files in order
3. Track in `migration_log` table

**Key Files**:
- `/infra/database/` — Migration files
- `/infra/lambdas/database-migration/` — Runner Lambda

---

## Lambda Functions

### Processing Lambdas

**Location**: `/infra/lambdas/`

| Lambda | Purpose |
|--------|---------|
| `textract/` | OCR document processing |
| `group-sync/` | Google Directory synchronization |
| `atrium-content-key-bootstrap/` | Atrium key provisioning |
| `agent-router/` | Agent request routing with promoted turn recovery |
| `agent-cron/` | Scheduled run telemetry including contention settlement |

### Agent Router

The `agent-router` Lambda handles agent request routing with automatic failure telemetry hygiene:

**Promoted Turn Recovery**: When an interactive turn times out (~550s ceiling) or overflows context but is promoted to a job queue, `markPromotedTurnRecovered()` downgrades the failure row from `error` to `warn` with `system:job-promotion` acknowledgment. This preserves latency trending while ensuring the Failures tab shows what actually broke.

**Dead-Letter Telemetry**: When a chat turn exhausts its SQS retries and is about to dead-letter, `recordIfHeadedForDlq()` writes a failure row *before* the redrive happens. The function:

- **Extracts owner attribution**: Parses the record body to capture `userId` (sender email) and `sessionId` (space name), so "who was affected?" is answerable from the failure table without decoding SQS bodies by hand
- **Fails safe on missing attributes**: If `ApproximateReceiveCount` is missing or unparseable, records anyway—the prior default of "skip" meant records with no attributes dead-lettered silently
- **Receives retry limit via env var**: `ROUTER_QUEUE_MAX_RECEIVE_COUNT` is passed from the stack (line 122 of `/infra/lib/agent-platform-stack.ts`) to ensure Lambda and queue redrive policy stay synchronized
- **Decouples retry latency from DB health**: Visibility shortening runs before the telemetry write, so a slow or exhausted DB pool cannot block prompt retry

Without this telemetry, deferred retries could vanish with no `agent_failures` row, no metric, and nothing on the usage dashboard. In production (2026-08-20 to 2026-08-31), 50 real user messages died across 8 people while the failure table recorded only 2 router-sourced rows that week—the DLQ alarm had been publishing to a topic with no subscribers.

For multi-turn agent architecture, see **[agent-platform/overview.md](../agent-platform/overview.md)**.

### Agent Platform Lambdas

| Lambda | Purpose |
|--------|---------|
| `agent-mint/` | DWD token broker (isolated security) |
| `hyperframes-render/` | HTML to video rendering |
| `agent-media/` | HTML-to-PDF, ffmpeg transcode/probe, and Amazon Transcribe |

### Agent Media Function

**Source**: `/infra/lib/constructs/compute/agent-media-function.ts`, `/infra/agent-media/`

A container-image Lambda providing three capabilities the agent kept having to refuse (issue #1738):

| Operation | Purpose |
|-----------|---------|
| `html-to-pdf` | Headless Chromium print-to-PDF, honouring `@page` CSS |
| `media` | ffprobe inspection + ffmpeg transcode via named presets |
| `transcribe` | Amazon Transcribe over audio in owner's private workspace |

**Why separate from hyperframes-render**: IAM isolation. That role may write only to `public-images/`; this one reads/writes owners' private workspace prefixes and carries an explicit DENY on `public-images/`. A scanned IEP or staff recording must never become a public-by-link object.

**Security model**: The function never accepts an identity from its caller. The relay injects `workspacePrefix` after the web-verified invocation context; the caller supplies only workspace-relative paths, validated against traversal, backslashes, and control characters. Publishing stays a separate act through `psd-publish-file`.

**Configuration**: x86_64 container (Chromium + FFmpeg cannot live in agent image), 4096 MB memory, 900s timeout, 6144 MB ephemeral storage, reserved concurrency 5. Amazon Transcribe scoped to `agent-media-*` job name prefix so this role cannot disturb other account jobs.

#### Chromium Lambda Sandbox Compatibility

**Source**: `/infra/agent-media/handler.js` — `CHROMIUM_BASE_FLAGS`

Chromium requires a specific set of flags to start inside Lambda's sandbox. The `CHROMIUM_BASE_FLAGS` constant (frozen array) captures the flags that answer each stderr failure from the 2026-09-06 production incident:

| Flag | Answers |
|------|---------|
| `--no-sandbox` | setuid sandbox unavailable |
| `--disable-gpu` | GPU rendering disabled |
| `--in-process-gpu` | GPU process launch failure (FATAL) |
| `--disable-software-rasterizer` | SwiftShader fallback process blocked |
| `--no-zygote` | Zygote fork failure |
| `--disable-crash-reporter` | crashpad ptrace denied |
| `--disable-dev-shm-usage` | `/dev/shm` too small |

**`--single-process` is deliberately NOT a base flag.** On 2026-09-06, a build carrying it exited 0 and wrote no PDF at all—the shape that failure takes when the flag interacts with `--print-to-pdf`. It also breaks `@font-face { src: local(...) }`, which needs the browser process's font service.

**Critical: Local tests do not prove Lambda compatibility.** On 2026-09-06, Docker Desktop smoke tests passed (correct 612×792pt PDF geometry) while the deployed function could not print a single page. Lambda's sandbox refuses the GPU-process spawn, zygote fork, and crashpad ptrace attach—none of which reproduce locally, even with `--cap-drop=ALL --security-opt no-new-privileges`. Local runs prove output quality (geometry, layout, codecs); they prove nothing about whether the binary can start where it has to.

#### Two-Attempt Execution and Artifact Gating

The `htmlToPdf` function uses a two-attempt strategy ordered by what the captured stderr actually said:

1. **Primary attempt**: `CHROMIUM_BASE_FLAGS` only — full fidelity, no known print interaction
2. **Fallback attempt**: Adds `--single-process` only if primary produces nothing — addresses remaining sandbox uncertainty without another deploy cycle

Each attempt gates success on `fileExists(target)` rather than the exit code. Chromium can exit 0 and write nothing; the artifact is the only thing worth believing. The log line reports which attempt won so the next reader does not have to guess.

The handler also logs Chromium stderr on success (not just on failure), filtered through `notableStderr()` to drop the ~2KB of benign dbus/UPower/font-lookup chatter each headless run emits. Anything not matching the filter is kept, so new failure modes still surface rather than being silenced.

**Required post-deploy check** (after any Dockerfile, Chromium flag, or base image change):

```bash
aws lambda invoke --function-name psd-agent-media-dev --cli-read-timeout 200 \
  --payload '{"operation":"html-to-pdf","workspacePrefix":"probe/","userEmail":"probe@psd401.net","html":"<!doctype html><h1>probe</h1>","pageSize":"letter"}' \
  /tmp/agent-media-probe.json >/dev/null && python3 -c "import json;d=json.load(open('/tmp/agent-media-probe.json'));print(d['status'], d.get('bytes') or d.get('message'))"
```

`ok <bytes>` means Chromium started and printed. Anything else prints the real diagnostic. Since 2026-09-06, errors are also logged to CloudWatch (previously the log group held only `START`/`END`/`REPORT`).

**Focused Tests**: `/infra/agent-media/handler.test.js` — validates that `--single-process` is NOT in `CHROMIUM_BASE_FLAGS`, confirms required flag pairing, and asserts the set is frozen

### Workspace Contract Validation

**Source**: `/infra/agent-image/workspace_contract.py`

During agent image builds, a cutover guard fingerprints the workspace contract (proof version, checkpoint manifest, journal shapes) and compares it against the deployed image. This prevents false-positive cutover triggers from comment or validation-logic changes.

For details, see **[agent-platform/overview.md → Workspace Checkpoint Recovery → Cutover Guard](../agent-platform/overview.md#cutover-guard-build-time-contract-validation)**.

### Lambda Optimization

PowerTuning results documented in `/docs/infrastructure/lambda-powertuning-results.md`:
- 66% memory reduction achieved
- Cold start optimization

---

## Authentication

### AWS Cognito + Google OAuth

- User pools with Google federation
- Crystal PSAD domain (`hd=psd401.net`)
- Role extraction from Cognito groups
- Session management via NextAuth v5

### Key Files

| File | Purpose |
|------|---------|
| `/auth.ts` | NextAuth configuration |
| `/lib/auth/` | Authentication utilities |
| `/docs/diagrams/05-authentication-flow.md` | Visual flow diagram |

---

## Secrets Management

### AWS Secrets Manager

All credentials stored in Secrets Manager with structured naming:

```
psd-agent/{env}/google-oauth-client
psd-agent/{env}/internal-api-key
psd-agent/{env}/gcp-dwd-config
psd-agent/{env}/agent-gateway
psd-agent-creds/{env}/user/{email}/google-workspace-user
```

### Access Pattern

- IAM role grants least-privilege access
- 5-minute cache for settings
- No secrets in environment variables or code

---

## Storage

### S3 Buckets

| Bucket | Purpose |
|--------|---------|
| Document uploads | Knowledge repository files |
| Atrium content | Published content storage |
| Attachments | Nexus chat attachments |

### Storage Optimization

- Lifecycle policies for cost management
- Presigned URLs for large file access
- Versioning enabled for content buckets

See `/docs/features/s3-storage-optimization.md` for details.

---

## Monitoring

### CloudWatch

- Structured JSON logging via `/lib/logger.ts`
- Request ID tracing across all operations
- OpenTelemetry (ADOT) for distributed tracing

### Dashboards

- Per-environment CloudWatch dashboards
- Custom metrics for AI usage
- Alarm thresholds for reliability

### Alarm Delivery

All agent platform alarms use **dual-topic delivery** to prevent silent failures:

1. **Dedicated topic**: `psd-agent-alarms-{env}` with optional email subscription
2. **Shared topic**: `aistudio-{env}-monitoring-alarms` (cross-stack, always has confirmed subscriber)

This pattern exists because SNS email subscriptions can silently disappear. In production (2026-07-24), an email subscription was created but nobody clicked the confirmation link; SNS deleted it after 3 days while CloudFormation still showed `CREATE_COMPLETE`. The router DLQ alarm fired for 36 days with zero subscribers, and 50 user messages died in the DLQ unnoticed.

**Implementation**: The `notifyAgentAlarm()` helper in `/infra/lib/agent-platform-stack.ts` ensures every alarm publishes to both topics. The helper now throws at synth time if called before `agentAlarmTargets` is populated—preventing the previous `?? []` fallback that could silently produce a valid synth with no alarm actions.

**Self-Monitoring**: The `AgentAlarmDeliveryFailures` alarm watches `AWS/SNS NumberOfNotificationsFailed` on the shared monitoring topic. If SNS publish fails, the alarm fires—catching the case where an alarm is in ALARM state but nobody receives notification. This alarm itself publishes to the same dual topics.

**Tests**: `/infra/test/agent-alarm-delivery.test.ts` validates that every notifying alarm reaches the shared topic and that `notifyAgentAlarm()` refuses to wire before targets exist.

#### Threshold Tuning

Agent platform alarms are tuned to eliminate false positives while preserving real-fault detection:

**Dead-Boot Alarm**: Uses threshold ≥2 across 3 consecutive periods (previously ≥1 over 1 period). A microVM that logs `BUILD_MARKER` just before a period boundary logs `BootOk` just after it, showing a transient +1 difference. Over 7 days of production, `BuildMarkerBoot` and `BootOk` were exactly equal (9562 each) while 18% of periods crossed the old threshold—about 52 pages a day. A straddle self-corrects in the next period, so requiring the deficit to persist across 3 periods eliminates timing artifacts. A genuine r10 dead boot (gateway/provider/model resolution failing outright) affects every boot in the window and crosses immediately.

**Cron Error Alarm**: Watches a filtered metric (`CronUnexpectedInvokeError`) that excludes `JobLockAcquisitionError`. The cron handler intentionally throws this error so Lambda re-invokes the fire—it is control flow, not a failure. Over 24h of production, 100% of cron invoke errors were this retry mechanism, none were genuine. The metric filter `"Invoke Error" -JobLockAcquisitionError` ensures new/unknown error types still alarm immediately.

Neither change makes the platform quieter about real faults: the DLQ, delivery, throttle, and schedule-rejection alarms are untouched, and both alarms still fire on the conditions they were written for.

#### Namespace Assignment Ordering

When adding new alarms or metric filters that depend on `resources.failureMetricNamespace`, the assignment must occur BEFORE any Metric construction reads it. CloudFormation synthesizes successfully when a Metric receives `namespace: undefined`, but deploy fails with "Namespace must not be blank". This class of bug passes synth and unit tests but fails at deploy time.

**Invariant**: `resources.failureMetricNamespace` is set at the start of `createBaseMonitoring()` in `/infra/lib/agent-platform-stack.ts`, before `createCronAlarms()` or any other method that builds Metric objects.

**Test Coverage**: `/infra/test/agent-alarm-delivery.test.ts` includes `'gives every alarm a metric namespace'` which iterates all CloudWatch alarms in the synthesized template and asserts non-math-expression alarms have a Namespace property. This catches the synth-succeeds/deploy-fails class of bug before reaching production.

### Key Files

| File | Purpose |
|------|---------|
| `/lib/monitoring/` | Monitoring utilities |
| `/infra/lib/constructs/monitoring/` | Dashboard definitions |
| `/infra/test/agent-alarm-delivery.test.ts` | Alarm routing validation |
| `/docs/operations/PERFORMANCE_TESTING.md` | Load testing procedures |

---

## Atrium Sandbox Configuration

### Content Security Policy Configuration (#1750)

**Source**: `/infra/lib/atrium-sandbox-stack.ts`, `/infra/lib/frontend-stack-ecs.ts`, `/infra/cdk.json`

The Atrium artifact sandbox enforces a Content Security Policy that restricts external script and style sources. The CSP allowlist is configured in **`infra/cdk.json`** under the `atriumAllowedArtifactCdns` context key, ensuring:

1. **Single source of truth**: The same comma-separated origin list feeds both the sandbox CSP (enforcement) and the ECS task environment (guidance)
2. **No silent empty allowlist**: The default lives in `cdk.json` instead of a `--context` flag, preventing deployments from accidentally shipping an empty allowlist
3. **Deterministic catalog generation**: The capability catalog snapshot (`docs/API/v1/generated/capability-catalog.json`) pins the allowlist from `cdk.json` for byte-identical output across environments

**Configuration Location**: `/infra/cdk.json` → `context.atriumAllowedArtifactCdns`

Example:
```json
{
  "context": {
    "atriumAllowedArtifactCdns": "https://cdnjs.cloudflare.com"
  }
}
```

The allowlist is:
- Baked into the sandbox CSP by `AtriumSandboxStack` (`script-src`/`style-src`/`img-src`)
- Injected as `ATRIUM_ALLOWED_ARTIFACT_CDNS` on the ECS task
- Dynamically appended to MCP tool descriptions and agent skill guidance

**Invariant**: Every origin in the allowlist enlarges the trusted surface for ALL artifacts. Keep the list minimal and add origins only on request. The `connect-src` directive remains `'none'`, so the no-egress invariant holds regardless of CDN entries.

### Agent-Skill CDN Drift Guard (#1764)

**Source**: `/infra/test/agent-skill-cdn-allowlist.test.ts`

Agent skills are static prose documents baked into the agent image, built and deployed separately from the app. Without a gate, a skill can confidently instruct a model to load a library from an origin the CSP then blocks silently—the page renders, the feature is dead, and nothing errors. This is the exact failure mode that #1750 fixed, relocated to a surface with no automated link to the source of truth.

The drift guard test prevents this by asserting alignment between `atriumAllowedArtifactCdns` and the guidance files:

**Default-Deny Host Detection**: Every absolute URL extracted from `.md`/`.html` files under `/infra/agent-image/skills/` must have its host classified into one of three categories:

| Category | Meaning | Example |
|----------|---------|---------|
| **Allowlisted** | Origins in `atriumAllowedArtifactCdns` | `cdnjs.cloudflare.com` |
| **Documented-as-blocked** | Counter-examples steering models away from known failures | `fonts.googleapis.com` (font-src is hardcoded `data:`) |
| **Non-asset reference** | Documentation links, API endpoints, PSD properties—exempt from script/style checks | `github.com`, `docs.google.com` |

**Key Invariants**:

1. **No unclassified hosts**: Every extracted host must appear in one of the three sets—default-deny catches unpredicted origins
2. **Allowlist documents all usable CDNs**: If an origin is in the CSP, the skills must name it
3. **Blocked and allowlisted sets stay disjoint**: A host cannot be both usable and documented as blocked
4. **Known CDN vendors flagged even as bare hosts**: "just use unpkg.com" without scheme is still caught
5. **Non-asset exemption cannot waive through CDNs**: The exemption list is for documentation hosts only; a real CDN can never be parked there

**Why predetermined lists cannot work**: The risk is a skill naming an origin nobody predicted. A shortlist of known CDN hosts would pass exactly the drift it should catch. Default-deny is structural.

**Focused Tests**: `/infra/test/agent-skill-cdn-allowlist.test.ts`

**CI Integration**: Runs in the same "Validate CDK Infrastructure" job as other infrastructure tests (`.github/workflows/ci.yml`).

### Build-Time Drift Guard (#1771)

**Source**: `/infra/agent-image/check_config_consistency.py` — `check_skill_cdn_allowlist()`

The PR-level drift guard protects the pull-request path, but `build-and-push.sh` builds from the working tree. An image can be built and pushed from a checkout that never saw a PR. The build-time gate provides equivalent protection for this path.

**How it works**:

1. Extracts `atriumAllowedArtifactCdns` from `infra/cdk.json`
2. Scans `.md`/`.html` files under `psd-atrium` and `psd-html-artifact` skills
3. Extracts `https://` origins (scheme-anchored to exclude blocked-origin counter-examples without scheme)
4. Validates bidirectional agreement:
   - Every named origin is in the allowlist (skill never recommends blocked CDN)
   - Every allowlisted origin is named by some skill (CSP never grants unseen capability)
5. Rejects contradictions where a non-loadable reference host is allowlisted

**Key invariants**:

- **Port-sensitive matching**: `https://cdn.example.com:8443` and `https://cdn.example.com` are different origins; the regex preserves ports to match CSP normalization
- **Non-loadable exemption**: Hosts like `psd401.ai` (documentation links) and `app.example` (RFC 2606 placeholders) are exempt from CDN checks—they're never in `<script src>`
- **Scheme-anchored matching**: Counter-examples like "fonts.googleapis.com is blocked" (no scheme) are excluded without prose intent analysis

**Focused Tests**: `/infra/agent-image/test_check_config_consistency.py` — `SkillCdnAllowlistTests`

**Test Command**:
```bash
cd infra/agent-image && python -m pytest test_check_config_consistency.py::SkillCdnAllowlistTests -v
```

**Why two gates**: The PR test catches drift before merge; the build check catches drift in direct builds. Both are required because the skills ride the agent image (separate deploy pipeline) while the allowlist lives in `cdk.json` (app deploy pipeline).

### Deployment Requirement

When changing `atriumAllowedArtifactCdns`, both stacks must be deployed together:

```bash
cd infra && bunx cdk deploy AIStudio-AtriumSandboxStack-Dev AIStudio-FrontendStack-ECS-Dev
```

This ensures the CSP enforced by the sandbox matches the guidance the app provides to artifact authors.

**CSP Guidance**: The `ATRIUM_ALLOWED_ARTIFACT_CDNS` environment variable is consumed by `/lib/content/artifact-sandbox-config.ts` → `buildArtifactCspGuidance()` to generate a one-sentence CSP note for artifact authors. This guidance is appended to MCP tool descriptions and agent skills. See **[app-features/overview.md](../app-features/overview.md#atrium--content-workspace)** for the feature-level CSP documentation.

**Focused Tests**:
- `/infra/test/atrium-sandbox-csp.test.ts` — validates CSP construction from allowlist
- `/infra/test/agent-skill-cdn-allowlist.test.ts` — gates agent skill guidance against CSP allowlist (PR path, #1764)
- `/infra/agent-image/test_check_config_consistency.py` — gates agent skill guidance against CSP allowlist (build path, #1771)
- `/tests/smoke/atrium-artifact-sandbox-config.smoke.ts` — smoke test for runtime CSP config
- `/tests/unit/atrium-mcp-content-tools.test.ts` — validates CSP guidance in MCP tools

---

## Security

### K-12 Content Safety

**Documentation**: `/docs/features/k12-content-safety.md`

Amazon Bedrock Guardrails provide:
- Content filtering (violence, hate, sexual content)
- PII detection and tokenization
- Copilot/FERPA/CIPA compliance support
- Real-time SNS alerts for violations

### IAM Least Privilege

**Documentation**: `/docs/security/USING_IAM_SECURITY.md`

- Tag-based access control
- Role-filtered capabilities
- Isolated agent execution

### Network Security

- VPC with public/private/isolated subnets
- Security groups for each tier
- VPC endpoints for AWS services

See `/docs/diagrams/02-vpc-network-topology.md` for network diagram.

---

## Deployment Safety

### Pre-Deployment Checklist

From `/infra/DEPLOYMENT_SAFETY_CHECKLIST.md`:

1. Run `bun run lint` and `bun run typecheck`
2. Verify migrations in `/infra/database/migrations.json`
3. Run tests: `bun run test:e2e`
4. Review CDK diff
5. Check secrets are current

### Deployment Commands

**Full documentation**: `/infra/DEPLOYMENT_COMMANDS.md`

```bash
# Deploy all stacks
cd infra && bunx cdk deploy --all

# Deploy with context
bunx cdk deploy -c environment=dev

# Hotswap for fast iteration (dev only)
bunx cdk deploy --hotswap
```

---

## Testing Infrastructure

### Infrastructure Jest Tests

**Location**: `/infra/test/`, `/infra/**/__tests__/`

Infrastructure uses Jest with @swc/jest transformer (migrated from ts-jest for TypeScript 7 compatibility). Tests validate stack synthesis, IAM policies, Lambda configurations, and CSP constructions.

**Test Categories**:

| Category | Location | Purpose |
|----------|----------|---------|
| Stack synthesis | `/infra/test/*stack*.test.ts` | Validate stack outputs, resources |
| Lambda tests | `/infra/**/__tests__/*.test.ts` | Unit tests for Lambda handlers |
| CSP validation | `/infra/test/atrium-sandbox-csp.test.ts` | Artifact sandbox CSP construction |
| Alarm routing | `/infra/test/agent-alarm-delivery.test.ts` | Dual-topic alarm delivery validation |
| CDN drift guard | `/infra/test/agent-skill-cdn-allowlist.test.ts` | Agent skill guidance vs. sandbox CSP allowlist consistency |

**Execution**:

```bash
cd infra && bun test                    # Run all infrastructure tests (serial)
cd infra && bun test --testPathPattern=atrium-sandbox-csp  # Run specific test file
```

**Serial execution required**: Infrastructure tests must run with `--runInBand` (enforced by jest.config.js) because concurrent workers deadlocking on CDK Lambda asset staging. The serial run completes 58 suites / 543 tests in ~95s.

**CI Integration**: Infrastructure jest runs in the "Validate CDK Infrastructure" job (`.github/workflows/ci.yml`), gated alongside the root test suite.

---

## CI/CD Workflows

**Location**: `.github/workflows/`

AI Studio uses GitHub Actions for continuous integration and deployment. Non-trivial workflows consume reusable workflows from the org repository (`PSD401/.github`) for consistency across district projects.

### Reusable Workflow Consumers

| Workflow | Reusable Source | Purpose |
|----------|-----------------|---------|
| `claude-code-review.yml` | `PSD401/.github/.github/workflows/reusable-claude-review.yml@main` | AI-assisted PR review |
| `openwiki-update.yml` | `PSD401/.github/.github/workflows/reusable-openwiki.yml@main` | Automated documentation regeneration |

### Caller Pattern

Caller workflows are minimal—granting permissions and passing configuration:

```yaml
jobs:
  openwiki:
    permissions:
      contents: write
      pull-requests: write
    uses: PSD401/.github/.github/workflows/reusable-openwiki.yml@main
    with:
      base_branch: dev
    secrets: inherit
```

Benefits:
- Single source of truth for workflow logic
- Centralized security and dependency updates
- Reduced boilerplate in repository callers

### Index of Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push to dev, PR | Lint, typecheck, tests |
| `claude-code-review.yml` | PR opened/ready | AI-assisted code review |
| `openwiki-update.yml` | Push to dev (excluding openwiki/**), weekly schedule | Regenerate OpenWiki docs |
| `agent-eval-nightly.yml` | Nightly schedule | Agent skill evaluation |
| `codeql.yml` | Weekly schedule | Security analysis |

---

## Key Source Files

| File/Directory | Purpose |
|----------------|---------|
| `/infra/bin/infra.ts` | CDK app entrypoint |
| `/infra/lib/stacks/` | Stack definitions |
| `/infra/lib/constructs/` | Reusable patterns |
| `/infra/database/` | Migrations |
| `/infra/lambdas/` | Lambda function code |
| `/infra/policies/` | Cedar policies |
| `/infra/agent-image/` | Agent container |
| `/.github/workflows/` | CI/CD workflows |

---

## Related Concepts

- **[architecture/overview.md](../architecture/overview.md)** — Overall architecture
- **[data-models/overview.md](../data-models/overview.md)** — Database schema
- **[agent-platform/overview.md](../agent-platform/overview.md)** — Agent-specific infrastructure
