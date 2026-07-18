---
type: Data Model Overview
title: Database Schema & Data Models
description: Aurora Serverless v2 PostgreSQL with Drizzle ORM, 60+ tables organized into functional domains with type-safe queries and JSONB columns.
tags: [database, schema, drizzle, postgresql]
---

# Data Models

AI Studio uses Aurora Serverless v2 (PostgreSQL) with Drizzle ORM for type-safe database operations.

## ORM & Connection

### Drizzle ORM Configuration

- **Driver**: postgres.js (direct PostgreSQL connection)
- **Connection Pooling**: Max 20 connections per container, 20s idle timeout
- **Location**: `/lib/db/`

### Key Files

| File | Purpose |
|------|---------|
| `/lib/db/drizzle-client.ts` | Database client with connection pooling |
| `/lib/db/schema/index.ts` | Barrel export of all table schemas |
| `/lib/db/schema/tables/*.ts` | Individual table definitions |
| `/lib/db/types/jsonb/` | JSONB type definitions |
| `/lib/db/drizzle/*.ts` | Domain-specific query functions |

### Query Patterns

Always use Drizzle queries for type safety:

```typescript
import { eq, and, desc } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { users, userRoles, roles } from "@/lib/db/schema";

// SELECT with type safety
const user = await executeQuery(
  (db) => db.select().from(users).where(eq(users.id, userId)).limit(1),
  "getUserById"
);

// Transaction with automatic rollback
await executeTransaction(
  async (tx) => {
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));
    await tx.insert(userRoles).values(roleIds.map(id => ({ userId, roleId: id })));
  },
  "updateUserRoles"
);
```

**Critical Pattern**: Never nest `db.transaction()` inside `executeQuery()`. Use `executeTransaction()` directly.

---

## Schema Organization

### Core Domain Tables

**Users & Authentication**
| Table | Purpose |
|-------|---------|
| `users` | User accounts linked to Cognito, with email uniqueness constraint |
| `roles` | Available roles (Admin, Staff, Student) |
| `user_roles` | User-role associations (managed via group sync) |
| `capabilities` | Role-gated UI feature registry (synced from `/lib/capabilities/manifest.ts`) |
| `role_capabilities` | Role-to-capability mappings |

**Groups** (Google Directory Sync)
| Table | Purpose |
|-------|---------|
| `groups` | Google Directory groups |
| `group_members` | Group membership |
| `group_role_mappings` | Group-to-role automatic assignments |
| `group_selection_rules` | Admin-configured sync rules |

---

### AI & Models

**Model Management**
| Table | Purpose |
|-------|---------|
| `ai_models` | Registered AI models with provider metadata |
| `ai_streaming_jobs` | Active streaming job tracking |
| `model_comparisons` | Side-by-side comparison results |
| `model_replacement_audit` | Model substitution audit trail |

**Nexus Conversations**
| Table | Purpose |
|-------|---------|
| `nexus_conversations` | Conversation containers |
| `nexus_messages` | Individual messages with routing metadata |
| `nexus_folders` | User organization folders |
| `nexus_shares` | Cross-user conversation sharing |
| `nexus_templates` | Reusable conversation templates |
| `nexus_user_preferences` | Per-user Nexus settings |
| `nexus_provider_metrics` | Provider performance tracking |

**Nexus MCP**
| Table | Purpose |
|-------|---------|
| `nexus_mcp_servers` | Registered MCP servers |
| `nexus_mcp_connections` | Active connections |
| `nexus_mcp_capabilities` | Server capabilities |
| `nexus_mcp_audit_logs` | MCP operation audit |
| `nexus_mcp_user_tokens` | Per-user MCP authentication |

---

### Content & Documents

**Atrium Content**
| Table | Purpose |
|-------|---------|
| `content_collections` | Content namespaces |
| `content_objects` | Documents and artifacts |
| `content_versions` | Version history |
| `content_visibility_grants` | Access permissions |
| `content_publications` | Published content |
| `atrium_doc_state` | Live collaborative state (Yjs CRDT) |
| `atrium_doc_comments` | Comments and track changes |
| `content_audit_logs` | Content modification audit |
| `content_publish_requests` | Public publish approval queue |

**Knowledge Repositories**
| Table | Purpose |
|-------|---------|
| `knowledge_repositories` | Repository definitions |
| `repository_items` | Uploaded documents |
| `repository_item_chunks` | Vector-searchable chunks |
| `repository_access` | Repository permissions |
| `documents` | Legacy document storage |
| `document_chunks` | Legacy chunk storage |

---

### Assistant Architect

| Table | Purpose |
|-------|---------|
| `assistant_architects` | Custom assistant definitions |
| `chain_prompts` | Prompt chain configurations |
| `tool_input_fields` | Tool input definitions |
| `tool_executions` | Tool run history |
| `tool_edits` | Tool configuration changes |
| `prompt_results` | Chain execution results |
| `assistant_architect_events` | Execution events |

---

### Agent Platform

**Agent Telemetry**
| Table | Purpose |
|-------|---------|
| `agent_messages` | Agent communications |
| `agent_sessions` | Session tracking |
| `agent_feedback` | User feedback on agent actions |
| `agent_health_snapshots` | Health monitoring |
| `agent_failures` | Failure tracking |
| `agent_patterns` | Pattern recognition |

**Agent Skills**
| Table | Purpose |
|-------|---------|
| `agent_skills` | Published skill definitions |
| `agent_skill_audit` | Skill management audit |
| `agent_identities` | Agent identity tracking |

**Agent Workspace**
| Table | Purpose |
|-------|---------|
| `agent_workspace_tokens` | Token manifest |
| `agent_workspace_consent_nonces` | One-time consent URLs |

**Credential Management**
| Table | Purpose |
|-------|---------|
| `agent_credentials_audit` | Credential access audit |
| `agent_credential_reads` | Every credential read |
| `agent_credential_requests` | Permission requests |

---

### API & OAuth

**API Keys**
| Table | Purpose |
|-------|---------|
| `api_keys` | API key definitions with scopes |
| `api_key_usage` | Usage tracking |

**OAuth2/OIDC Provider**
| Table | Purpose |
|-------|---------|
| `oauth_clients` | Registered OAuth applications |
| `oauth_authorization_codes` | Authorization code flow |
| `oauth_access_tokens` | Access tokens (15min TTL) |
| `oauth_refresh_tokens` | Refresh tokens (24hr TTL) |
| `jwks_keys` | JWT signing keys |
| `oauth_consent_decisions` | User consent records |

---

### Scheduling & Jobs

| Table | Purpose |
|-------|---------|
| `jobs` | Job definitions |
| `scheduled_executions` | Scheduled run configurations |
| `execution_results` | Job output storage |
| `user_notifications` | Notification queue |

---

### Supporting Tables

**Navigation**
| Table | Purpose |
|-------|---------|
| `navigation_items` | Nav bar entries |
| `navigation_item_roles` | Role-based visibility |

**Prompt Library**
| Table | Purpose |
|-------|---------|
| `prompt_library` | Shared prompts |
| `prompt_tags` | Tag definitions |
| `prompt_library_tags` | Prompt-tag associations |
| `prompt_usage_events` | Usage tracking |

**Ideas**
| Table | Purpose |
|-------|---------|
| `ideas` | User-submitted ideas |
| `idea_votes` | Voting records |
| `idea_notes` | Staff notes on ideas |

**Settings**
| Table | Purpose |
|-------|---------|
| `settings` | Database-first configuration |

**Migration Tracking**
| Table | Purpose |
|-------|---------|
| `migration_log` | Migration history |
| `migration_mappings` | ID mappings for migrations |

**Context Graph**
| Table | Purpose |
|-------|---------|
| `graph_nodes` | State graph nodes |
| `graph_edges` | State transitions |

---

## JSONB Type Safety

JSONB columns are typed via `.$type<T>()` in schema definitions:

```typescript
// Schema definition
settings: jsonb("settings").$type<UserSettings>(),

// Type definition
export interface UserSettings {
  theme: "light" | "dark" | "system";
  notifications: boolean;
  // ...
}

// Query - TypeScript knows the shape
user.settings.theme;  // Type-safe access
```

Type definitions live in `/lib/db/types/jsonb/`.

---

## Migrations

### Migration Workflow

1. Modify schema in `/lib/db/schema/tables/`
2. Generate migration: `bun run drizzle:generate`
3. Prepare for Lambda: `bun run migration:prepare`
4. Add to manifest: Update `migrationFiles` array in `/infra/database/migrations.json`
5. Deploy via CDK

### Migration Rules

- **Files 001-005 are IMMUTABLE** — Never modify legacy migrations
- **Only add migrations 010+**
- **Always add to `migrationFiles` array** — Lambda deployment reads this manifest

### Documentation

- `/docs/database/drizzle-migration-guide.md` — Complete migration guide
- `/docs/database/drizzle-patterns.md` — Common patterns
- `/docs/database/drizzle-troubleshooting.md` — Issue resolution

---

## Aurora Serverless v2 Configuration

| Environment | Configuration |
|-------------|---------------|
| **Dev** | Auto-pause enabled (scales to 0 ACU) |
| **Prod** | Min 2 ACU, Max 8 ACU, always-on |

**Connection Management**:
- `DATABASE_URL` for local development
- `DB_HOST/DB_USER/DB_PASSWORD` for ECS (from Secrets Manager)
- Pool auto-manages connections (max 20 per container)
- Graceful shutdown via `/instrumentation.ts`

---

## Related Concepts

- **[architecture/overview.md](../architecture/overview.md)** — ORM usage patterns
- **[infrastructure/overview.md](../infrastructure/overview.md)** — Database deployment
