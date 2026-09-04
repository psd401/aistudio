---
type: Feature Overview
title: Core Application Features
description: Multi-model AI chat with automatic routing, no-code assistant builder, agent-native content workspace with artifact data bridge, and knowledge repositories for K-12 education platform.
tags: [features, nexus, atrium, assistants, knowledge]
openwiki:
  roles: [architecture, domain]
  source_paths:
    - actions/db/atrium/artifact-query.ts
    - actions/db/atrium/artifact-guards.ts
    - actions/db/atrium/workspace-panel.ts
    - actions/db/atrium/create-content.ts
    - actions/db/atrium/snapshot-document.ts
    - actions/db/atrium/comments.ts
    - lib/nexus/model-router/psd-data-connector.ts
    - components/atrium/dnd/atrium-dnd.tsx
    - components/atrium/use-expanded-sections.ts
    - components/atrium/ArtifactSandbox.tsx
    - components/atrium/ArtifactCanvas.tsx
    - lib/content/types.ts
    - lib/content/code-encoding.ts
    - lib/content/code-encoding-browser.ts
    - lib/atrium/usage-series.ts
    - lib/atrium/recent-window.ts
  invariants:
    - Artifact data_access modes (records/query/none) are mutually exclusive — prevents exfiltration loop
    - Mode is enforced twice (client-side pin + server-side check) and changes only take effect on fresh page load (#1712)
    - Bridge enabled on authoring surfaces (view page, editor canvas, workspace panel); embeds/thumbnails/public reader stay fail-closed (#1725)
    - Canvas sandbox keys on contentId:dataAccess:versionId — one mount belongs to one artifact in one mode
    - normalizeDataAccess fails unrecognized values closed to 'none'
    - Viewer-scoped PSD queries execute as the VIEWER with their row-level security
    - Sidebar tree starts collapsed; expanded sections persist per-viewer in localStorage
    - What's New window is 7 days, hour-truncated to prevent render-loop refetches
    - Unfiled view drops collection scope rather than ANDing into empty grid
    - Content bodies that may contain HTML tags MUST use base64 transit encoding — raw posts trip WAF CrossSiteScripting_BODY with a silent 403 (#1714)
    - Server-action callers MUST catch — a WAF-blocked POST rejects instead of resolving, and without catch the spinner runs forever
  validation_commands:
    - bun run typecheck
    - bun run lint
  test_paths:
    - tests/e2e/atrium-artifact-data-access.functional.spec.ts
    - tests/unit/atrium-artifact-query-action.test.ts
    - tests/unit/atrium-artifact-data-access-migration.test.ts
    - tests/unit/atrium-artifact-data-bridge.test.tsx
    - tests/unit/atrium-reader-page-masking.test.tsx
    - tests/unit/atrium-artifact-view-page-bridge.test.tsx
    - tests/unit/atrium-artifact-canvas-bridge.test.tsx
    - tests/unit/atrium-artifact-bridge-fail-closed.test.tsx
    - tests/unit/atrium-data-access-normalize.test.ts
    - tests/unit/atrium-workspace-panel-action.test.ts
    - tests/unit/atrium-workspace-panel.test.tsx
    - tests/unit/atrium-create-content-code-encoding.test.ts
    - tests/unit/atrium-snapshot-document-action.test.ts
    - tests/unit/atrium-comments-actions.test.ts
    - tests/unit/atrium-create-content-dialog.test.tsx
    - tests/unit/atrium-library-artifact-create.test.tsx
    - tests/e2e/atrium-document-snapshot-waf.functional.spec.ts
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
| `/lib/nexus/model-router/psd-data-connector.ts` | Shared PSD Data MCP server resolution (used by Nexus and Atrium artifact queries) |
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

### Content Surface Links

**Source**: `/lib/content/reader-links.ts`

Content links resolve based on publication status:

- **Published** → Canonical reader link (`/c/{slug}`) — accessible to anyone with visibility
- **Draft/Archived** → Authoring surface link (`/atrium/{id}/view` or `/edit`) — requires `canView`, renders head version

The `contentSurfaceLink()` function handles this routing automatically. This fix resolved dead links for unpublished content (e.g., psd-morning-brief artifacts that are never published) where the reader link would 404 for both recipients and owners.

### Content Body Transit Encoding

**Problem**: The ALB WAF's `CrossSiteScripting_BODY` rule (AWS-managed rule set) blocks any POST body containing `<script>`, `<style>`, or similar XSS-like markup with a bare 403—no app logs, no error message. This silently broke artifact creation, document saves with authorship markup, and comments discussing HTML code.

**Solution**: Content bodies that may contain raw HTML are sent base64-encoded, making them opaque to the WAF's XSS inspection. The server decodes at the transport boundary before any validation or screening runs.

**Encoding Modules**:
- `lib/content/code-encoding-browser.ts` — Browser encoder (`toBase64Utf8`), Web APIs only
- `lib/content/code-encoding.ts` — Server decoder (`decodeContentBody`), Node Buffer-based

**Supported Actions** (all accept `opts: { codeEncoding?: "base64" }`):
- `createContentAction` — Library artifact creation (both "Build it for me" and "Start blank")
- `createVersionAction` — Document canvas save
- `createCommentThreadAction` / `replyToCommentAction` — Comment submission

**Key Insight**: The raw HTML is often NOT what the user typed. The Tiptap editor's authorship marks render as real `<span data-atrium-authored>` tags during serialization. Every human-edited document carries unescaped HTML that the WAF would block. **Always serialize and inspect before assuming a write path is safe** from the WAF.

**When Adding New Write Surfaces**:
1. Check if the body can contain `<script>`, `<style>`, or inline `style=`/`onerror=` attributes
2. If yes, use `toBase64Utf8` on the client and pass `{ codeEncoding: "base64" }` to the action
3. Wrap the action call in `try/catch`—a WAF 403 makes the action REJECT, not resolve with `isSuccess: false`

**Source**: `/docs/learnings/security/2026-09-03-alb-waf-crosssitescripting-body-blocks-raw-html-content-writes.md` — comprehensive WAF documentation.

**Focused Tests**:
- `tests/unit/atrium-create-content-code-encoding.test.ts` — encoding/decoding roundtrip
- `tests/unit/atrium-snapshot-document-action.test.ts` — document save with encoding
- `tests/unit/atrium-comments-actions.test.ts` — comments with encoded bodies
- `tests/e2e/atrium-document-snapshot-waf.functional.spec.ts` — full save path with realistic markup

### Visibility & Publishing

- **Private** — Only author
- **Intranet** — Staff with visibility grants
- **Public** — External web with approval queue
- **Group grants** — Share with specific Google groups

### Library & Favorites

**Library Home** provides a curated landing experience:
- **Favorites band** — Personal starred content surfaced when user has favorites
- **Recent activity** — Recently viewed and edited content
- **Section pages** — Dedicated landing pages for content collections (via `/atrium/s/<slug>`)

**Favorites** let users star content for quick access:
- Implemented via `content_user_favorites` join table (composite PK: `user_id`, `object_id`)
- Favorites are visibility-gated — starring does not grant access if visibility changes
- Toggle via `FavoriteStar` component, backed by `/lib/content/favorites-service.ts`
- Empty favorites band is suppressed (no empty state shown)

**Section Landing Pages** (`components/atrium/SectionLanding.tsx`) provide collection-specific navigation with settings dialogs for collection owners.

**What's New Band** — District-wide recently touched content:
- 7-day rolling window of content with `updated_at` activity
- Surfaces on Library Home when district has recent activity
- Links to dedicated "What's new" view with same filter scope
- Hour-truncated timestamp prevents render-loop refetches (`/lib/atrium/recent-window.ts`)

**Artifact Creation Dialog** (`components/atrium/CreateContentDialog.tsx`):
- Two paths: "Build it for me" (agent) or "Start blank" (empty canvas)
- Per-path load indicators — the clicked button spins, not both (#1714)
- Both paths encode the starter body via `toBase64Utf8` to bypass WAF XSS inspection
- Wrapped in `try/catch` so WAF 403s surface as error messages instead of infinite spinners

### Library View Filters

The library grid provides filter chips that map to server-side `ListFilter` fields:

| Chip | Filter Field | Behavior |
|------|-------------|----------|
| **All content** | — | No filter restriction |
| **Favorites** | `favorite: true` | Shows only starred content |
| **Docs** | `kind: "document"` | Documents only |
| **Artifacts** | `kind: "artifact"` | Artifacts only |
| **Unfiled** | `filed: "unfiled"` | Content not in any collection |
| **Archived** | `status: "archived"` | Archived content only |

**Filter Identity Architecture** — The `useLibraryPage` hook uses `JSON.stringify(filter)` for filter identity rather than manually destructuring fields. This prevents silent bugs where new filter fields are added but forgotten in the dependency array. The serialized filter is rendered as `data-results-key` on the grid section so E2E tests can wait for filter changes without racing the debounce.

**Instant Removal in Filtered Views** — When unstarring content inside the Favorites view, the card is removed immediately (local removal, no refetch). The card no longer matches the view's filter condition. In other views, the card remains because the star state is not a filter.

**Section Scope vs. Unfiled** — The `scopedCollectionId` helper drops collection scope when entering the Unfiled view. A `?collection=X` deep link combined with "Unfiled" would otherwise AND `collection_id = X` with `collection_id IS NULL`, resulting in an empty grid by construction.

**Focused Test**: `tests/e2e/atrium-library-view-filters.functional.spec.ts` — Regression guard for Favorites and Unfiled chip filters, including error state handling and legacy `?collection=` scope interactions.

### Sidebar & Navigation

**Expanded Section State** — Per-viewer persistence:
- Tree starts **collapsed** by default (no more fully-expanded on every visit)
- Expanded sections stored in `localStorage` per user (`atrium.expandedSections:{userId}`)
- Survives navigation, reload, and cross-tab updates via `storage` event listeners
- Hook: `/components/atrium/use-expanded-sections.ts`

**Drag-and-Drop** — Single DndContext over the entire shell (`/components/atrium/dnd/atrium-dnd.tsx`):

| Gesture | Action |
|---------|--------|
| Drag card onto section | Move content into collection (`updateContentAction`) |
| Drag card onto "Sections" heading | Un-file content |
| Drag section onto another's middle band | Nest collection inside target |
| Drag section onto sibling's top/bottom edge | Reorder at that position |
| Drag section onto its group heading | Move to top level |

Permission is enforced server-side on every drop; the client hides handles it knows would be refused (`node.canManage`). Uses @dnd-kit/core with mouse (distance threshold), touch (hold-to-drag), and keyboard sensors.

**Focused Tests**:
- `tests/e2e/atrium-sidebar-dnd.functional.spec.ts` — drag-and-drop operations
- `tests/e2e/atrium-sidebar-collapse.functional.spec.ts` — expanded section persistence

### Artifact Data Access

Artifacts can interact with data through a sandbox bridge. The `data_access` mode on each content object determines which operation is allowed.

**Data Access Modes** (mutually exclusive, migration 179):

| Mode | Allowed Operations | Use Case |
|------|-------------------|----------|
| `records` | `AtriumData.submit`, `AtriumData.list` | Artifact persists JSON records (default) |
| `query` | `AtriumData.query` | Viewer-scoped PSD data queries (read-only) |
| `none` | None | No data bridge operations |

**Security Model**: The modes are mutually exclusive by design to prevent exfiltration. An artifact that can query viewer data cannot also write records, closing the loop where a hostile author could query sensitive data and exfiltrate it through the records store.

**Where the Bridge is Live** (#1725):

| Surface | Bridge | Why |
|---------|--------|-----|
| `/c/<slug>` intranet reader | **enabled** | Authenticated, `canView`-gated, published |
| `/atrium/<id>/view` full-screen viewer | **enabled** | Renders CURRENT head — the one surface a draft can run on |
| `/atrium/<id>/edit` canvas preview | **enabled** | Where the artifact is authored |
| Nexus workspace panel (`?workspace=`) | **enabled** | Same canvas behind same `canView`-gated loader |
| `ArtifactEmbedBlock` (artifact inside document) | fail closed | Renders inside somebody else's document, including anonymous reader |
| Library thumbnails | fail closed | Decorative grid tiles; nothing to interact with |
| `/p/<slug>` public reader | fail closed | Anonymous — no viewer to scope a query to |

**Publication was never the authorization** — `queryArtifactData`, `submitArtifactRecord`, and `listArtifactRecords` each independently resolve the session, run `contentService.get` (the shared 404 mask + `canView`), re-check `kind === "artifact"`, and re-check the artifact's CURRENT `data_access` mode. None reads publication state. Enabling the bridge on authoring surfaces changes only *where* a request may originate, not *who* may run one — and removes the publish → test → republish loop where an author could not exercise a query-mode dashboard until it was in front of an audience.

**Dual-Layer Enforcement** (#1712): Each mode is enforced twice, and both layers must agree. The reader page pins the mode it read when it rendered, and the sandbox refuses any operation that does not match that pinned mode. The Server Actions independently re-check the artifact's current mode. A mode change (settings, REST `PATCH`, MCP) only takes effect on a fresh page load, which starts with no queried data in memory. This prevents the owner from loading a viewer with `query` mode, then flipping to `records` to let that page submit queried rows back into the records store—exactly the exfiltration loop the mutual exclusivity is meant to close.

**Pinning Mechanism**:
- Reader page (`app/(protected)/c/[slug]/page.tsx`) reads `data_access` during render and passes it to `<ArtifactSandbox dataAccess=…>`
- Full-screen viewer (`app/(protected)/atrium/[id]/view/page.tsx`) does the same for drafts — keyed on `obj.id` so one mount is one artifact
- Workspace panel action (`loadWorkspacePanelAction`) returns `dataAccess` for artifacts, so the pin is server-resolved like every other bridge input
- `ArtifactSandbox` stores the mode in a ref for the mount's lifetime—re-renders cannot widen what an already-running artifact may do
- `isOpAllowedByLoadedMode()` rejects ops before the Server Action is called
- `normalizeDataAccess()` in `/lib/content/types.ts` collapses unrecognized values to `"none"` (fail closed)
- Canvas sandbox keys on `contentId:dataAccess:versionId` — flipping the mode in Content settings remounts the frame (the "fresh load" the pin requires), and an artifact change also remounts

**Viewer-Scoped PSD Queries** (`query` mode):
- Artifact calls `window.AtriumData.query(sql, { limit, offset })`
- Query executes **as the viewer** with their row-level security
- Author cannot influence which rows the viewer sees
- Uses the same PSD Data MCP connector as Nexus chat (resolved via `/lib/nexus/model-router/psd-data-connector.ts`)
- Rate limit: 60 queries per viewer per artifact per minute
- SQL capped at 8,000 characters; limit clamped to 2,000 rows

**Artifact API** (installed by sandbox host):
```typescript
interface AtriumData {
  submit(namespace: string, payload: Record<string, unknown>): Promise<{ id: string; createdAt: string }>;
  list(namespace: string, options?: { limit?: number; scope?: "all" | "mine" }): Promise<{ records: Array<{...}> }>;
  query(sql: string, options?: { limit?: number; offset?: number }): Promise<{ columns: string[]; rows: unknown[][]; ... }>;
}
```

**Source**: `/docs/features/atrium-artifact-data.md` — comprehensive data bridge documentation.

**Focused Tests**:
- `tests/e2e/atrium-artifact-data-access.functional.spec.ts` — data access modes including draft query on view page
- `tests/unit/atrium-artifact-query-action.test.ts` — query action
- `tests/unit/atrium-artifact-data-access-migration.test.ts` — migration 179
- `tests/unit/atrium-artifact-data-bridge.test.tsx` — loaded-mode pin (#1712, both directions plus `none`)
- `tests/unit/atrium-reader-page-masking.test.tsx` — reader page prop assertions including unrecognized mode pinning
- `tests/unit/atrium-artifact-view-page-bridge.test.tsx` — view page enables bridge for drafts (#1725)
- `tests/unit/atrium-artifact-canvas-bridge.test.tsx` — canvas props threading and sandbox keying
- `tests/unit/atrium-artifact-bridge-fail-closed.test.tsx` — embed block and thumbnails remain fail-closed
- `tests/unit/atrium-data-access-normalize.test.ts` — `normalizeDataAccess` helper
- `tests/unit/atrium-workspace-panel-action.test.ts` — action returns `dataAccess` pin
- `tests/unit/atrium-workspace-panel.test.tsx` — panel threads `dataAccess` to canvas

### Usage Dashboard

Administrators can view aggregate content activity on `/admin/atrium` → Usage tab.

**Source of Truth**: `content_audit_logs` (append-only mutation trail)

**Metrics Available**:
- Created/Updated/Published counts by time range (7d, 30d, 90d, all)
- Last 24h and last 7d breakouts
- Human vs. agent actor breakdown
- Per-author activity totals
- Per-section activity totals
- Daily activity series (zero-filled for contiguous display)

**Key Files**:
- `/actions/db/atrium/usage-stats.ts` — server action
- `/lib/atrium/usage-series.ts` — daily series helpers
- `/components/atrium/admin/atrium-usage-panel.tsx` — UI

**Focused Test**: `tests/e2e/atrium-usage-dashboard.functional.spec.ts`

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
