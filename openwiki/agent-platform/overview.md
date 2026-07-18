---
type: Platform Overview
title: Agent Platform & Skills System
description: Extensible agent skill system with 27+ domain-specific capabilities, Google Workspace integration, Cedar governance, and MCP tool exposure for K-12 AI assistants.
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
- `psd-atrium` — Read/search/create content in Atrium
- `psd-freshservice` — IT service desk integration
- `psd-email-triage` — Automated email response drafting
- `psd-schedules` — Schedule management
- `psd-rules` — Tier-1 governance rules for agent behavior

**Content & Media**
- `psd-aistudio` — Live capability discovery + authenticated actions in AI Studio
- `psd-learning-page` — Multimodal UDL learning page generation
- `psd-hyperframes` — HTML/CSS/JS to MP4 video rendering
- `psd-html-artifact` — Accessible HTML artifact delivery with a11y audit
- `psd-pdf-to-markdown` — Document conversion
- `psd-image-gen` — Image generation

**Data & Integration**
- `psd-data` — District data queries (PowerSchool, spreadsheets)
- `psd-workspace` — Google Workspace wrapper for agent accounts
- `psd-credentials` — Secure credential management and capability verification
- `psd-canva` — Canva design integration
- `psd-plaud` — Plaud note integration
- `psd-open-adaptive-district` — Adaptive learning platform

**Analysis & Reporting**
- `psd-classified-evaluation` — Staff evaluation document processing
- `psd-failure-report` — Failure analysis and reporting
- `psd-last30days` — Recent activity analysis
- `psd-github` — GitHub integration
- `psd-summarize` — Content summarization
- `psd-tts` — Text-to-speech

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
