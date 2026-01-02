# Database Entity-Relationship Diagram (ERD)

Complete database schema for AI Studio with 40+ tables organized by domain.

## Core User & Access Control

```mermaid
erDiagram
    users ||--o{ user_roles : has
    users ||--o{ user_notifications : receives
    users ||--o{ nexus_user_preferences : has
    users {
        int id PK
        varchar cognito_sub UK
        varchar email
        varchar first_name
        varchar last_name
        timestamp created_at
        timestamp last_sign_in_at
    }

    roles ||--o{ user_roles : assigned
    roles ||--o{ role_tools : grants
    roles {
        int id PK
        varchar name UK
        text description
        boolean is_system
        timestamp created_at
    }

    tools ||--o{ role_tools : "restricted by"
    tools {
        int id PK
        varchar identifier UK
        varchar name
        text description
        boolean is_active
    }

    user_roles {
        int id PK
        int user_id FK
        int role_id FK
        timestamp created_at
    }

    role_tools {
        int id PK
        int role_id FK
        int tool_id FK
        timestamp created_at
    }
```

## AI Models & Configuration

```mermaid
erDiagram
    ai_models ||--o{ nexus_messages : uses
    ai_models ||--o{ chain_prompts : uses
    ai_models ||--o{ model_comparisons : "compared in"
    ai_models {
        int id PK
        text name
        text provider
        text model_id UK
        text capabilities
        int max_tokens
        boolean active
        boolean nexus_enabled
        boolean architect_enabled
        jsonb allowed_roles
        numeric input_cost_per_1k_tokens
        numeric output_cost_per_1k_tokens
        numeric cached_input_cost_per_1k_tokens
        timestamp pricing_updated_at
        int average_latency_ms
        int max_concurrency
        boolean supports_batching
        jsonb nexus_capabilities
        jsonb provider_metadata
    }

    model_comparisons {
        bigint id PK
        int user_id FK
        text prompt
        int model1_id FK
        int model2_id FK
        text response1
        text response2
        int execution_time_ms1
        int execution_time_ms2
        int tokens_used1
        int tokens_used2
        jsonb metadata
    }

    settings {
        int id PK
        varchar key UK
        text value
        text description
        varchar category
        boolean is_secret
    }
```

## Nexus Chat System

```mermaid
erDiagram
    users ||--o{ nexus_conversations : owns
    users ||--o{ nexus_folders : owns
    users ||--o{ nexus_templates : creates
    users ||--o{ prompt_library : creates

    nexus_conversations ||--o{ nexus_messages : contains
    nexus_conversations ||--o{ nexus_conversation_events : tracks
    nexus_conversations ||--o{ nexus_provider_metrics : "has metrics"
    nexus_conversations ||--o{ nexus_shares : "shared via"
    nexus_conversations ||--o{ nexus_conversation_folders : "organized in"
    nexus_conversations {
        uuid id PK
        int user_id FK
        varchar provider
        varchar title
        varchar model_used
        uuid folder_id FK
        int message_count
        int total_tokens
        timestamp last_message_at
        boolean is_archived
        boolean is_pinned
        jsonb metadata
    }

    nexus_messages {
        uuid id PK
        uuid conversation_id FK
        varchar role
        text content
        jsonb parts
        int model_id FK
        text reasoning_content
        jsonb token_usage
        varchar finish_reason
        jsonb metadata
        timestamp created_at
    }

    nexus_folders ||--o{ nexus_conversation_folders : contains
    nexus_folders {
        uuid id PK
        int user_id FK
        uuid parent_id FK
        varchar name
        varchar color
        varchar icon
        int sort_order
        boolean is_expanded
        jsonb settings
    }

    nexus_conversation_folders {
        uuid conversation_id FK
        uuid folder_id FK
        int position
        boolean pinned
        timestamp archived_at
    }

    nexus_provider_metrics {
        uuid id PK
        uuid conversation_id FK
        varchar provider
        varchar model_id
        int prompt_tokens
        int completion_tokens
        int cached_tokens
        int reasoning_tokens
        int response_time_ms
        numeric cost_usd
        varchar status
    }

    nexus_shares {
        uuid id PK
        uuid conversation_id FK
        int shared_by FK
        varchar share_token UK
        timestamp expires_at
        int view_count
    }

    nexus_cache_entries {
        varchar cache_key PK
        varchar provider
        uuid conversation_id FK
        int ttl
        timestamp expires_at
        int hit_count
        int byte_size
    }
```

## Assistant Architect & Prompts

```mermaid
erDiagram
    users ||--o{ assistant_architects : creates
    assistant_architects ||--o{ chain_prompts : contains
    assistant_architects ||--o{ tool_executions : executed
    assistant_architects ||--o{ tool_input_fields : "has inputs"
    assistant_architects ||--o{ tool_edits : "edited via"
    assistant_architects ||--o{ scheduled_executions : scheduled

    assistant_architects {
        int id PK
        text name
        text description
        enum status
        boolean is_parallel
        int timeout_seconds
        text image_path
        int user_id FK
        timestamp created_at
    }

    chain_prompts {
        int id PK
        int assistant_architect_id FK
        text name
        text content
        text system_context
        int model_id FK
        int position
        int parallel_group
        jsonb input_mapping
        jsonb repository_ids
        jsonb enabled_tools
        int timeout_seconds
    }

    tool_executions ||--o{ prompt_results : generates
    tool_executions ||--o{ assistant_architect_events : "logs events"
    tool_executions {
        int id PK
        int assistant_architect_id FK
        int user_id FK
        jsonb input_data
        enum status
        text error_message
        timestamp started_at
        timestamp completed_at
    }

    prompt_results {
        int id PK
        int execution_id FK
        int prompt_id FK
        jsonb input_data
        text output_data
        enum status
        text error_message
        int execution_time_ms
        text user_feedback
        timestamp started_at
        timestamp completed_at
    }

    assistant_architect_events {
        int id PK
        int execution_id FK
        enum event_type
        jsonb event_data
        timestamp created_at
    }

    tool_input_fields {
        int id PK
        int assistant_architect_id FK
        text name
        text label
        enum field_type
        jsonb options
        int position
    }

    tool_edits {
        int id PK
        int assistant_architect_id FK
        int user_id FK
        jsonb changes
        timestamp created_at
    }

    scheduled_executions ||--o{ execution_results : produces
    scheduled_executions {
        int id PK
        int user_id FK
        int assistant_architect_id FK
        text name
        jsonb schedule_config
        jsonb input_data
        boolean active
        timestamp created_at
    }

    execution_results {
        int id PK
        int scheduled_execution_id FK
        jsonb result_data
        text status
        text error_message
        int execution_duration_ms
        timestamp executed_at
    }
```

## Knowledge Repositories & Documents

```mermaid
erDiagram
    users ||--o{ knowledge_repositories : owns
    knowledge_repositories ||--o{ repository_items : contains
    knowledge_repositories ||--o{ repository_access : "shared via"

    knowledge_repositories {
        int id PK
        text name
        text description
        int owner_id FK
        boolean is_public
        jsonb metadata
        timestamp created_at
    }

    repository_items ||--o{ repository_item_chunks : "split into"
    repository_items {
        int id PK
        int repository_id FK
        text type
        text name
        text source
        text processing_status
        text processing_error
        jsonb metadata
        timestamp created_at
    }

    repository_item_chunks {
        int id PK
        int item_id FK
        text content
        int chunk_index
        jsonb metadata
        vector embedding
        int tokens
        timestamp created_at
    }

    repository_access {
        int id PK
        int repository_id FK
        int user_id FK
        int role_id FK
        timestamp created_at
    }

    users ||--o{ documents : uploads
    documents ||--o{ document_chunks : "chunked into"
    documents {
        int id PK
        int user_id FK
        int conversation_id FK
        text name
        text type
        int size
        text url
        jsonb metadata
        timestamp created_at
    }

    document_chunks {
        int id PK
        int document_id FK
        text content
        int chunk_index
        int page_number
        jsonb embedding
        jsonb metadata
        timestamp created_at
    }

    textract_jobs {
        varchar job_id PK
        int item_id FK
        varchar file_name
        timestamp created_at
    }

    textract_usage {
        date month PK
        int page_count
        timestamp created_at
        timestamp updated_at
    }
```

## Prompt Library & Templates

```mermaid
erDiagram
    users ||--o{ nexus_templates : creates
    users ||--o{ prompt_library : submits
    users ||--o{ prompt_usage_events : generates

    nexus_templates {
        uuid id PK
        int user_id FK
        varchar name
        text description
        text prompt
        jsonb variables
        boolean is_public
        int usage_count
        timestamp created_at
    }

    prompt_library ||--o{ prompt_library_tags : tagged
    prompt_library {
        uuid id PK
        int user_id FK
        varchar title
        text content
        text description
        varchar visibility
        varchar moderation_status
        int moderated_by FK
        uuid source_message_id FK
        uuid source_conversation_id FK
        int view_count
        int use_count
        timestamp created_at
        timestamp deleted_at
    }

    prompt_tags ||--o{ prompt_library_tags : used
    prompt_tags {
        int id PK
        varchar name UK
        timestamp created_at
    }

    prompt_library_tags {
        uuid prompt_id FK
        int tag_id FK
        timestamp created_at
    }

    prompt_usage_events {
        int id PK
        uuid prompt_id FK
        int user_id FK
        varchar event_type
        uuid conversation_id FK
        timestamp created_at
    }
```

## MCP (Model Context Protocol) Integration

```mermaid
erDiagram
    nexus_mcp_servers ||--o{ nexus_mcp_capabilities : provides
    nexus_mcp_servers ||--o{ nexus_mcp_connections : "connects to"
    nexus_mcp_servers {
        uuid id PK
        varchar name
        text url
        varchar transport
        varchar auth_type
        varchar credentials_key
        int[] allowed_users
        int max_connections
        timestamp created_at
    }

    nexus_mcp_capabilities {
        uuid id PK
        uuid server_id FK
        varchar type
        varchar name
        text description
        jsonb input_schema
        jsonb output_schema
        varchar sandbox_level
        int rate_limit
    }

    nexus_mcp_connections {
        uuid id PK
        uuid server_id FK
        int user_id FK
        varchar status
        timestamp last_health_check
        int latency_ms
        int error_count
        int success_count
        varchar circuit_state
        text last_error
    }

    nexus_mcp_connections ||--o{ nexus_mcp_audit_logs : "logs actions"
    nexus_mcp_audit_logs {
        uuid id PK
        int user_id FK
        uuid server_id FK
        varchar tool_name
        jsonb input
        jsonb output
        text error
        int duration_ms
        inet ip_address
        text user_agent
        timestamp created_at
    }
```

## Navigation & UI

```mermaid
erDiagram
    navigation_items ||--o{ navigation_items : "parent of"
    navigation_items ||--o{ navigation_item_roles : "restricted by"
    navigation_items {
        int id PK
        text label
        text icon
        text link
        int parent_id FK
        int tool_id FK
        text requires_role
        int position
        boolean is_active
        enum type
        text description
    }

    navigation_item_roles {
        int id PK
        int navigation_item_id FK
        varchar role_name
        timestamp created_at
    }
```

## Background Jobs & Streaming

```mermaid
erDiagram
    users ||--o{ jobs : submits
    users ||--o{ ai_streaming_jobs : "creates streaming"

    jobs {
        int id PK
        int user_id FK
        enum status
        text type
        text input
        text output
        text error
        timestamp created_at
        timestamp updated_at
    }

    ai_streaming_jobs {
        uuid id PK
        text conversation_id
        int user_id FK
        int model_id FK
        enum status
        jsonb request_data
        jsonb response_data
        text partial_content
        text error_message
        boolean message_persisted
        timestamp created_at
        timestamp completed_at
    }
```

## Ideas & Voting System

```mermaid
erDiagram
    users ||--o{ ideas : submits
    users ||--o{ idea_votes : casts
    users ||--o{ idea_notes : writes

    ideas ||--o{ idea_votes : "voted on"
    ideas ||--o{ idea_notes : "has notes"
    ideas {
        int id PK
        int user_id FK
        text title
        text description
        text priority_level
        text status
        int votes
        timestamp created_at
        timestamp completed_at
        text completed_by
    }

    idea_votes {
        int id PK
        int idea_id FK
        int user_id FK
        timestamp created_at
    }

    idea_notes {
        int id PK
        int idea_id FK
        int user_id FK
        text content
        timestamp created_at
    }
```

## Migration & Audit Tables

```mermaid
erDiagram
    migration_log {
        int id PK
        int step_number
        text description
        text sql_executed
        varchar status
        text error_message
        timestamp executed_at
    }

    migration_mappings {
        varchar table_name
        text old_id
        int new_id
        varchar old_id_type
        timestamp created_at
    }

    model_replacement_audit {
        bigint id PK
        int original_model_id
        text original_model_name
        int replacement_model_id
        text replacement_model_name
        int replaced_by FK
        int chain_prompts_updated
        int conversations_updated
        timestamp executed_at
    }
```

## Table Statistics

| Domain | Tables | Key Features |
|--------|--------|--------------|
| **Users & Auth** | 5 | RBAC, tool permissions |
| **Nexus Chat** | 11 | Conversations, folders, caching, metrics |
| **Assistant Architect** | 9 | Multi-prompt chains, executions, scheduling |
| **Knowledge** | 7 | Repositories, documents, embeddings (pgvector) |
| **MCP Integration** | 4 | Server registry, capabilities, audit logs |
| **Prompt Library** | 5 | Templates, tagging, usage tracking |
| **AI Models** | 3 | Multi-provider support, cost tracking |
| **Jobs & Streaming** | 2 | Async processing, real-time streaming |
| **Navigation** | 2 | Dynamic menu, role-based display |
| **Ideas** | 3 | Voting system, notes |
| **Audit/Migration** | 3 | Schema versioning, model replacements |
| **Total** | **54 tables** | **PostgreSQL 15 with pgvector extension** |

## Key Relationships

### Core Entity Dependencies
1. **users** → Central entity referenced by 30+ tables
2. **ai_models** → Referenced by conversations, messages, chain_prompts
3. **assistant_architects** → Parent of chain_prompts, tool_executions
4. **nexus_conversations** → Container for messages, metrics, shares

### Foreign Key Cascade Rules
- **User deletion**: Cascade to user_roles, preferences (retain content for audit)
- **Conversation deletion**: Cascade to messages, events, metrics
- **Repository deletion**: Cascade to items, chunks, access
- **Execution deletion**: Cascade to prompt_results, events

## Indexes

### Performance-Critical Indexes
```sql
-- User lookups
CREATE INDEX idx_users_cognito_sub ON users(cognito_sub);
CREATE INDEX idx_users_email ON users(email);

-- Conversation queries
CREATE INDEX idx_nexus_conversations_user_id ON nexus_conversations(user_id);
CREATE INDEX idx_nexus_conversations_folder_id ON nexus_conversations(folder_id);
CREATE INDEX idx_nexus_messages_conversation_id ON nexus_messages(conversation_id);

-- Vector search (pgvector)
CREATE INDEX idx_repository_item_chunks_embedding ON repository_item_chunks
  USING ivfflat (embedding vector_cosine_ops);

-- Execution tracking
CREATE INDEX idx_tool_executions_user_id ON tool_executions(user_id);
CREATE INDEX idx_tool_executions_status ON tool_executions(status);

-- Scheduled jobs
CREATE INDEX idx_scheduled_executions_active ON scheduled_executions(active);
```

## Database Features

### PostgreSQL Extensions
- **pgvector**: Vector similarity search for embeddings
- **uuid-ossp**: UUID generation for distributed IDs
- **pg_trgm**: Full-text search support

### Custom Types (ENUMs)
- `job_status`: pending, running, completed, failed
- `execution_status`: pending, running, completed, failed
- `tool_status`: draft, published, archived
- `navigation_type`: link, section, divider
- `event_type`: Various execution events

### JSONB Usage
- **Metadata**: Flexible schema for evolving features
- **Settings**: Dynamic configuration without migrations
- **Metrics**: Token usage, performance data
- **Input/Output**: Execution data, tool parameters

## Data Retention

| Table Group | Retention Policy |
|-------------|------------------|
| **User data** | Indefinite (GDPR export on request) |
| **Conversations** | 90 days archived, then user-controlled deletion |
| **Executions** | 30 days dev, 90 days prod |
| **Audit logs** | 1 year minimum |
| **Metrics** | Aggregated monthly after 90 days |
| **Cache entries** | TTL-based auto-expiry |

## Backup Strategy

- **Full backup**: Daily at 2 AM UTC
- **Point-in-time recovery**: 7 days (dev), 30 days (prod)
- **Snapshot frequency**: Hourly incremental
- **Cross-region replication**: Prod only

---

**Last Updated**: November 2025
**Total Tables**: 54
**Database Size**: ~500 MB (dev), ~5 GB (prod projected)
**PostgreSQL Version**: 15.4
**Extensions**: pgvector, uuid-ossp, pg_trgm
