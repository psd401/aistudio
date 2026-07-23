---
type: Feature Overview
title: Core Application Features
description: Multi-model AI chat with automatic routing, no-code assistant builder, agent-native content workspace, and knowledge repositories for K-12 education platform.
tags: [features, nexus, atrium, assistants, knowledge]
---

# Core Application Features

AI Studio provides five major feature areas for K-12 educators and students, all accessible through the authenticated application at `/app/(protected)`.

## Nexus Chat

**Location**: `/app/(protected)/nexus/`

Conversational AI interface with automatic model routing, MCP tool integration, and conversation management.

### Automatic Model Routing

Nexus defaults to **Standard** mode where the server classifies each request and automatically selects the appropriate model:

1. **Authenticate** the user before classification
2. **Apply K-12 guardrails** (content filtering, PII tokenization)
3. **Classify intent** using deterministic capability rules for:
   - Image generation requests
   - PSD-data (district data) queries
   - Common instructional patterns
4. **Route to appropriate model** from configured tier candidates
5. **Persist routing decision** in message metadata for evaluation

**Runtime Modes** (`NEXUS_ROUTER_MODE` setting):
- `active` — Execute routed model with automatic connector selection
- `shadow` — Classify and record, but execute fallback model
- `off` — Use legacy model selection

See `/docs/features/nexus-model-routing.md` for full configuration.

### Conversation Architecture

- Hierarchical conversations with folders
- Message threading and navigation
- Persistent conversation history
- Real-time streaming responses

**Critical**: Read `/docs/features/nexus-conversation-architecture.md` before modifying any conversation code. This system has broken multiple times—follow documented patterns exactly.

### MCP Integration

Model Context Protocol tools integrated via:
- `/app/(protected)/nexus/_components/chat/mcp-popover.tsx` — UI for tool selection
- `/lib/mcp/tool-handlers.ts` — Server-side tool execution

Tools are gated by user capabilities and resource access grants.

### Key Source Files

| File | Purpose |
|------|---------|
| `/lib/nexus/model-router/router.ts` | Automatic model routing logic |
| `/lib/nexus/model-router/classifier.ts` | Intent classification |
| `/lib/nexus/history-adapter.ts` | Conversation history management |
| `/lib/nexus/enhanced-attachment-adapters.ts` | File attachment handling |

---

## Assistant Architect

**Location**: `/app/(protected)/prompt-library/`

No-code custom AI assistant builder with visual prompt chain designer.

### Capabilities

- **Visual prompt chain designer** — Chain multiple prompts with variable substitution
- **Tool integration** — Attach tools to assistants for extended capabilities
- **Knowledge repository linking** — Ground responses in uploaded documents
- **Scheduled execution** — Run assistants on a schedule with results stored
- **JSON import/export** — Share assistants between deployments

### Execution Flow

```
User Input → Variable Substitution → Prompt Chain Execution → Tool Calls → Results
```

1. User invokes assistant with input variables
2. System substitutes variables into prompt templates
3. Each prompt in the chain executes sequentially
4. Tool executions happen as defined in the assistant
5. Results are stored in `execution_results` table

### Agentic Mode

Assistants can operate in **agentic mode** for autonomous multi-step workflows:
- Automatic tool selection and execution
- Iterative reasoning and refinement
- Guarded by capability checks

See `/docs/features/assistant-architect-agentic-mode.md` for details.

### Key Source Files

| File | Purpose |
|------|---------|
| `/lib/assistant-architect/` | Core assistant execution logic |
| `/app/(protected)/prompt-library/` | UI for managing assistants |
| `/app/api/assistant-architect/execute/` | Execution endpoint |

---

## Atrium — Content Workspace

**Location**: `/app/(protected)/atrium/`

Agent-native content workspace supporting documents and interactive artifacts.

### Core Principles

From the design spec (`/docs/features/atrium-design-spec.md`):

1. **Parity** — Anything a person can do through UI, an agent can do through tools
2. **Granularity** — Tools are atomic primitives (`create`, `update`, `publish`)
3. **Composability** — New capabilities arrive as prompts/skills over primitives
4. **Content as Context** — Published content is retrievable as grounding

### Content Types

- **Documents** — Markdown content rendered via templates (Proof editor)
- **Artifacts** — Interactive content on sandboxed canvas (assistant-ui)

### Content API

The content API (`/lib/content/`) is the sole source of truth for content creation:

```
Destinations ← Content Layer ← Surfaces (UI, Agents, Scripts)
```

All surfaces are clients of the content API—there is no UI-only creation path.

### Visibility & Publishing

- **Private** — Only author
- **Intranet** — Staff with visibility grants
- **Public** — External web with approval queue
- **Group grants** — Share with specific Google groups

### MCP Tools

Atrium exposes content tools via `/lib/mcp/content-tools.ts`:
- `create_document`, `update_document`
- `publish_document`, `list_documents`
- Permission-aware retrieval for grounded responses

### Key Source Files

| File | Purpose |
|------|---------|
| `/lib/content/` | Content API services |
| `/components/atrium/` | Authoring UI components |
| `/app/(protected)/atrium/` | Atrium pages |

---

## Knowledge Repositories

**Location**: `/app/(protected)/repositories/`

Document upload, processing, and semantic search for context-aware AI responses.

### Supported Formats

PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, XML, YAML

### Processing Pipeline

```
Upload → S3 → Lambda (Textract) → Chunk → Embed → pgvector
```

1. Document uploaded to S3 via presigned URLs
2. Lambda function processes with Amazon Textract (OCR)
3. Content chunked for semantic search
4. Vector embeddings stored in `document_chunks` table
5. Retrieved as context for AI responses

### Storage Limits

- **Nexus attachments**: 500MB per file
- **Document processing**: 25MB per file (configurable)

### Key Source Files

| File | Purpose |
|------|---------|
| `/lib/document-processing.ts` | Document parsing and chunking |
| `/infra/lambdas/textract/` | OCR processing Lambda |
| `/lib/db/schema/tables/documents.ts` | Document storage schema |

---

## Model Compare

**Location**: `/app/(protected)/compare/`

Side-by-side evaluation of AI models for informed selection.

### Features

- Compare GPT-5, Claude, Gemini responses simultaneously
- Token usage and cost analysis per model
- Performance metrics tracking
- Share comparisons with team

### Key Source Files

| File | Purpose |
|------|---------|
| `/lib/compare/` | Comparison logic |
| `/app/(protected)/compare/` | Comparison UI |

---

## Feature Relationships

```
Nexus Chat
    ├── uses → Model Router → classifies → routes to AI Providers
    ├── integrates → MCP Tools → exposed by → Agent Platform
    └── grounds in → Knowledge Repositories

Assistant Architect
    ├── builds → Prompt Chains → executes → AI Providers
    ├── attaches → Tools → gated by → Capabilities
    └── links → Knowledge Repositories

Atrium
    ├── exposes → Content API → consumed by → Agent Skills
    ├── publishes → to Intranet → with Group Visibility
    └── stores → Documents & Artifacts → in S3 + PostgreSQL
```

## Related Concepts

- **[architecture/overview.md](../architecture/overview.md)** — Overall system architecture
- **[agent-platform/overview.md](../agent-platform/overview.md)** — Agent skills and MCP integration
- **[api-integration/overview.md](../api-integration/overview.md)** — External API access to these features
