---
type: Platform Overview
title: Agent Platform & Skills System
description: Extensible agent skill system with 36 domain-specific capabilities, Google Workspace integration, Cedar governance, and MCP tool exposure for K-12 AI assistants.
tags: [agents, skills, mcp, workspace, governance]
---

# Agent Platform

AI Studio includes an agent platform that enables autonomous AI assistants to perform real work through a growing library of skills. The platform prioritizes security, auditability, and K-12-specific workflows.

## Agent Skills System

**Location**: `/infra/agent-image/skills/`

Agent skills are modular capabilities packaged in standardized directories. Each skill follows the same structure:

```
infra/agent-image/skills/{skill-name}/
├── SKILL.md              # Skill definition and usage
├── run.js                # Primary execution logic
├── run.test.js           # Tests
├── package.json          # Dependencies
└── references/           # Supporting documentation
```

### Skill Categories

**Administrative & District Operations**
- `psd-atrium` — Read/search/create content in Atrium; artifact data persistence (list-data, submit); viewer-scoped PSD data queries from artifacts via shared connector resolution with Nexus
- `psd-freshservice` — IT service desk integration
- `psd-email-triage` — Automated email response drafting
- `psd-schedules` — Schedule management
- `psd-rules` — Tier-1 governance rules for agent behavior
- `psd-conversation-coach` — Crucial Conversations framework coaching for difficult conversations
- `psd-morning-brief` — Personalized daily newspaper/podcast delivered through private Atrium artifacts
- `psd-observances` — Cited dates for national observances, awareness months, state school holidays, and education conferences via NSPRA calendar lookups
- `psd-directory` — Identity lookup for staff and colleagues by email or Google Chat sender ID

**Content & Media**
- `psd-aistudio` — Live capability discovery + authenticated actions in AI Studio
- `psd-learning-page` — Multimodal UDL learning page generation
- `psd-hyperframes` — HTML/CSS/JS to MP4 video rendering
- `psd-html-artifact` — Accessible HTML artifact delivery with a11y audit
- `psd-pdf-to-markdown` — Document conversion
- `psd-image-gen` — Image generation
- `psd-sop-creator` — PSD Standard Operating Procedure document creation
- `psd-instructional-vision` — PSD instructional framework (Instructional Essentials, UDL, MTSS) from live repository

**Data & Integration**
- `psd-data` — District data queries (PowerSchool, spreadsheets)
- `psd-workspace` — Google Workspace wrapper for agent accounts
- `psd-credentials` — Secure credential management and capability verification
- `psd-canva` — Canva design integration
- `psd-plaud` — Plaud note integration
- `psd-open-adaptive-district` — Open Adaptive District operating model (six-week build cycle)

**Analysis & Reporting**
- `psd-deep-research` — Gemini Deep Research for cited multi-source reports
- `psd-workflows` — Dynamic PSD gateway workflows (evaluations, requests, timesheets) with caller binding
- `quartile-growth-report` — Growth-by-quartile spreadsheet generator for elementary school principals (one tab per grade, data-only output)
- `psd-failure-report` — Failure analysis and reporting
- `psd-last30days` — Recent activity analysis
- `psd-github` — GitHub integration
- `psd-summarize` — Content summarization
- `psd-tts` — Text-to-speech
- `psd-strategic-plan` — Peninsula 2030 strategic plan queries from live repository 166

**Utilities**
- `chat-card`, `chat-chart` — Chat UI enhancements
- `psd-brand-guidelines` — PSD branding enforcement
- `psd-skills-meta` — Skill metadata and discovery

### Skill Execution

Skills run in the agent container defined by `/infra/agent-image/Dockerfile`. The harness:
1. Loads skill from `/opt/psd-skills/{skill-name}/`
2. Validates governance policies via Cedar
3. Executes skill logic with requested capabilities
4. Audits all credential reads and tool invocations

### Bundled Skill Manifest

Agent image builds include a bundled skill catalog (`/infra/lib/bundled-skill-manifest.ts`) that enforces catalog approval for skill loads. The manifest:

- Parses SKILL.md frontmatter (name, summary, allowed-tools)
- Validates against image tag and source hash
- Registers skills via CloudFormation custom resource (`agent-skill-initializer` Lambda)
- Enforces catalog approval before execution

The skill initializer (`infra/lambdas/agent-skill-initializer/`) handles both registration and retirement of bundled skills, ensuring only approved capabilities execute in the agent container.

---

## Workspace Checkpoint Recovery

Agent workspaces use journal-based finalization proofs to survive invocation failures and resume idempotently.

### Journal-Based Finalization

When workspace changes are committed, a finalization proof is stored in the journal table with:

- Owner hash and workspace prefix
- Base generation and proof hash
- Reservation IDs and deleted paths
- Invocation nonce and expiry

If a final flush fails or times out, the harness retries the fenced batch at the start of the next invocation. The stored proof carries the original invocation's nonce and expiry.

### Journaled Replay

**Source**: `/lib/agent-workspace/storage-broker.ts`

The `journaledReplay` option in `verifyWorkspaceFinalizationProof()` relaxes ONLY the invocation binding—never the signature, workspace prefix, or generation. A byte-identical journal entry proves the request was already admitted under valid invocation, allowing the retry to succeed.

**Why it's safe**: The caller only passes `journaledReplay` when a journal entry on the same prefix matches the request byte for byte. Cross-generation and cross-owner replay remain blocked by the retained generation claim and manifest-generation check.

### Checkpoint Retry Recovery

**Source**: `/infra/agent-image/agentcore_wrapper.py`

When a pending checkpoint cannot be replayed, the local changes are quarantined (generation invalidated) and the turn continues with a full restore from the committed manifest. This records at `warn` severity with `recovered: true` and does not trigger alerts—the failure that matters is a restore that cannot be completed, which still raises.

### Session Lock Retention Diagnostics

**Source**: `/infra/lambdas/agent-router/index.ts` — `invokeWithSessionLockLease()`

When AgentCore completion is unconfirmed and a workspace lock is retained, the warning now includes `ownerEmail` and `spaceName` in addition to `sessionId`. A retained lock blocks all turns for that owner until the TTL expires (30 minutes), so identifying the affected user from logs requires owner attribution—`sessionId` alone is a hash that cannot be reversed.

Historical context: six retained-lock events belonged to one user, but correlating requestIds back to spaces required a manual research project. The diagnostic fields make this a log search.

---

## Failure Telemetry Hygiene

The agent platform carefully tracks failures while avoiding false positives from recovered turns.

### Deferred Failure Recording

**Source**: `/infra/agent-image/harness_adapter.py`

When `process()` may still recover a turn by retrying, the failure is held in `TurnResult.deferred_failure` rather than written immediately. The retry path:

- **Success**: Drops the deferred row—the turn recovered, so no `agent_failures` row is written
- **Failure**: Flushes both attempts' rows—the turn really did fail twice

This prevents recovered turns from inflating failure metrics. In the week of 2026-08-21, 8 of 10 `OpenClawChatError` rows had already been recovered by retry but were still written as errors, making 10 broken turns appear when only 2 actually failed.

### Promoted Turn Acknowledgement

**Source**: `/infra/lambdas/agent-router/index.ts`, `/infra/lambdas/agent-cron/run-telemetry.ts`

When an interactive turn times out or overflows but is promoted to a job queue, `markPromotedTurnRecovered()` downgrades the failure row:

- Severity set to `warn`
- Acknowledged with `system:job-promotion`
- Context marked with `promoted: true`

This preserves latency and overflow trending data while ensuring the Failures tab shows what actually broke. In the week of 2026-08-21, 14 of 35 hard-error rows described turns the user got answered via job promotion.

---

## Google Workspace Integration

**Documentation**: `/docs/features/agent-workspace-integration.md`

Per-user agents operate with their own Google Workspace identity (`agnt_<uniqname>@psd401.net`), delegated by users the same way they would delegate to a human assistant.

### Slot Model

| Slot | Identity | Auth Method |
|------|----------|-------------|
| **User slot** | Human's email | OAuth consent flow, refresh token in Secrets Manager |
| **Agent slot** | `agnt_*` account | Domain-wide delegation (DWD) token broker |

### DWD Token Broker (Security Hardening)

The DWD broker runs in an **isolated mint Lambda** (`psd-agent-mint-{env}`), not in the Next.js app, to prevent confused-deputy attacks:

```
API Route → IAM Invoke → Mint Lambda → WIF → Service Account → Google
                           ↑
                      Sole WIF Principal
```

If an attacker compromises the frontend, they can only invoke the mint Lambda—which always derives `agnt_<owner>` server-side—never arbitrary human identities.

### Account Provisioning

Agent accounts are provisioned automatically via OneSync sheet:
1. User requests agent action requiring workspace
2. Router detects unprovisioned account
3. Writes to OneSync `agents` sheet
4. Google creates `agnt_*` account within ~30 minutes

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| API Route | `/app/api/agent/workspace-token/` | Thin proxy to mint Lambda |
| API Route | `/app/api/agent/account-request/` | Auto-provisioning trigger |
| Mint Lambda | `/infra/lambdas/agent-mint/` | WIF token minting (isolated) |
| Workspace Skill | `/infra/agent-image/skills/psd-workspace/` | Google Workspace CLI wrapper |
| Cedar Policy | `/infra/policies/cedar/psd-agent-governance.cedar` | Capability allowlisting |

### Operation Allowlist

**Source**: `/lib/agent-workspace/command-executor.ts`

Google Workspace operations are classified into allowlist categories:

| Category | Description | Examples |
|----------|-------------|----------|
| `READ_ACTIONS` | Read-only operations, never mutate | `get`, `list`, `search`, `findDirectMessage` |
| `ALLOWED_WRITES` | User-slot permitted mutations | `gmail users settings filters`, `tasks tasks move` |
| `AGENT_ONLY_WRITES` | Agent-slot mutations only | `tasks tasks patch`, `tasks tasks update` |

The allowlist evolves based on production failure patterns. Recent additions:

| Operation | Reason |
|-----------|--------|
| `spaces.findDirectMessage` | DM lookup sends nothing; was refusing scheduled digests with no way to find target DM |
| `gmail users settings filters` | Inbox filter management; requires separate `gmail.settings.basic` scope |
| `tasks tasks move` | Task reordering within lists the user-slot can already insert into |

#### Scope Gap Handling

Some operations require OAuth scopes not implied by existing grants. The `requiredWorkspaceScopeGap()` function detects these gaps and returns a user-facing capability description and re-authorization link:

```
gmail.modify ≠ gmail.settings.basic
```

When a user attempts Gmail filter operations without `gmail.settings.basic`, they receive a prompt to re-authorize with the additional scope rather than an opaque Google 403.

---

## MCP Server

**Documentation**: `/docs/features/mcp-server.md`

AI Studio exposes its capabilities via Model Context Protocol (MCP) for external AI tools (Claude Code, Cursor, etc.).

### MCP Endpoint

```
POST /api/mcp
```

All MCP operations are authenticated via API keys with scoped permissions.

### Available Tools

Tools are projected from the app's registries in real-time:
- **Capability discovery** — `describe_capabilities` shows current tools
- **Assistant execution** — List and execute assistants
- **Decision capture** — Search and capture AI decisions
- **Content tools** — Atrium document operations
- **Agent workspace** — Google Workspace actions

### Scope Model

| Scope | Access |
|-------|--------|
| `mcp:list_assistants` | List available assistants |
| `mcp:execute_assistant` | Execute assistants |
| `content:read` | Read published content |
| `content:write` | Create/update content |

Key resolution follows a **shared-default, per-user-override** model:
- Default: Shared read-only `platform:read` key (discovery only)
- Override: User's personal API key (unlocks their full scopes)

---

## Cedar Governance

**Policy File**: `/infra/policies/cedar/psd-agent-governance.cedar`

All agent actions are validated against Cedar policies before execution.

### Governing Principles

1. **Allowlist principle** — Only explicitly permitted operations
2. **Least privilege** — Each skill gets minimum required capabilities
3. **Audit everything** — All actions logged with request context

### Policy Enforcement

```cedar
permit(principal, action, resource)
when { principal has capability && resource is allowed };
```

Policies are evaluated by the agent harness before each skill execution.

---

## Agent Identity & Auditing

### Identity Model

Agents operate with distinct identities tracked in `agent_identities` table:
- Human owner association
- Capability grants
- Audit trail linkage

### Audit Tables

| Table | Purpose |
|-------|---------|
| `agent_messages` | All agent communications |
| `agent_tool_invocations` | Tool calls made by agents |
| `agent_credential_reads` | Every credential access |
| `agent_credential_requests` | Permission to read credentials |
| `content_audit_logs` | Content creation/modification |

### Telemetry

Agent health monitoring via:
- `agent_health_snapshots`
- `agent_failures`
- `agent_patterns`

---

## Skill Publishing

**Documentation**: `/docs/features/skill-publishing.md`

Skills are published and managed through:
1. Admin interface at `/admin/agents/skills/`
2. Resource access grants for skill permissions
3. Audit of all skill operations

### Key Source Files

| File | Purpose |
|------|---------|
| `/infra/agent-image/skills/*/SKILL.md` | Individual skill definitions |
| `/lib/mcp/tool-handlers.ts` | MCP tool routing |
| `/lib/agent-workspace/` | Workspace integration logic |
| `/infra/lambdas/agent-router/` | Agent request routing |

---

## Related Concepts

- **[app-features/overview.md](../app-features/overview.md)** — Features agents interact with
- **[api-integration/overview.md](../api-integration/overview.md)** — External API access
- **[infrastructure/overview.md](../infrastructure/overview.md)** — Agent infrastructure deployment
