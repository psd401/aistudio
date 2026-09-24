---
type: Feature Overview
title: Core Application Features
description: Multi-model AI chat with automatic routing, no-code assistant builder, agent-native content workspace with artifact data bridge, and knowledge repositories for K-12 education platform.
tags: [features, nexus, atrium, assistants, knowledge]
openwiki:
  roles: [architecture, domain]
  source_paths:
    - lib/repositories/readiness-service.ts
    - lib/nexus/conversation-repository-service.ts
    - app/api/nexus/chat/route.ts
    - app/api/nexus/chat/image-generation-handler.ts
    - lib/ai/generated-image-bucket.ts
    - lib/ai/image-generation-service.ts
    - actions/db/atrium/artifact-query.ts
    - actions/db/atrium/artifact-guards.ts
    - actions/db/atrium/workspace-panel.ts
    - actions/db/atrium/create-content.ts
    - actions/db/atrium/snapshot-document.ts
    - lib/attachments/chat-attachment-adapters.ts
    - lib/attachments/use-chat-attachments.ts
    - actions/db/atrium/comments.ts
    - actions/db/atrium/publish-document.ts
    - lib/nexus/model-router/router.ts
    - lib/nexus/model-router/types.ts
    - lib/nexus/model-router/psd-data-connector.ts
    - lib/nexus/workspace-routing-contract.ts
    - lib/nexus/workspace-routing-context.ts
    - lib/nexus/model-router/workspace-auto-connector.ts
    - components/atrium/dnd/atrium-dnd.tsx
    - components/atrium/use-expanded-sections.ts
    - components/atrium/ArtifactSandbox.tsx
    - components/atrium/ArtifactCanvas.tsx
    - lib/content/types.ts
    - lib/content/code-encoding.ts
    - lib/content/code-encoding-browser.ts
    - lib/content/live-publication.ts
    - lib/content/publish-service.ts
    - lib/content/reader-links.ts
    - lib/content/atrium-data-contract.ts
    - lib/content/grant-targets.ts
    - lib/content/visibility-service.ts
    - lib/content/collection-management-service.ts
    - lib/atrium/usage-series.ts
    - lib/atrium/recent-window.ts
    - lib/atrium/workspace-change-event.ts
    - lib/nexus/workspace-chat-tools.ts
    - lib/nexus/chat-step-budget.ts
    - app/(protected)/nexus/_components/tools/use-workspace-change-signal.ts
    - actions/mcp-connector.actions.ts
    - app/(protected)/nexus/_components/chat/mcp-popover.tsx
    - app/(protected)/nexus/page.tsx
    - components/assistant-ui/thread.tsx
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
    - Publication is a single Live/Draft state — Level alone decides audience (#1726)
    - Public address /p/{slug} is derived from Level=public AND Live — not a separate destination
    - Making content live does not change audience — it only pins a version and adds to retrieval
    - WorkspacePanel and ArtifactCanvas are pure layout siblings of the Nexus conversation tree — DOM events (atrium:workspace-changed) are the ONLY communication path, never shared state or runtime imports (#1749)
    - One refresh owner — WorkspacePanel alone subscribes to the change event; it refetches then bumps ArtifactCanvas.refreshSignal; two independent subscribers would race and render mixed state
    - Step budget varies by tool presence — 20 steps when workspace tools bound (explore-then-build), 10 otherwise (#1749)
    - Shared data contract — DATA_ACCESS_DESC is imported by both MCP content tools and workspace chat tools so artifact-authoring surfaces cannot drift
    - psd-atrium skill's "Live PSD data inside an artifact" section is hand-maintained Markdown — editing lib/content/atrium-data-contract.ts does NOT update the skill automatically
    - read_workspace_content is paged, never truncated — one call returns at most 96 KiB with byteOffset/totalBytes/hasMore/nextOffset; model pages with offset until hasMore is absent (#1770)
    - Page edges land on UTF-8 character boundaries — concatenated pages reproduce source byte-for-byte with no replacement characters (#1770)
    - No read ceiling exists — resolveReadBody returns complete body; sliceBodyForRead pages it so nothing is unreachable (#1770)
    - Grant target existence is validated before storing — user grants must reference existing users.id, group grants must reference synced groups.group_email (#1777)
    - Only user/group are existence-checked — role matches by NAME, building/department/grade are free-text with no canonical list (#1777)
    - Group comparison uses lower(group_email) on both sides, matching the read path and handling mixed-case storage (#1777)
    - Out-of-range user IDs (>2147483647) are rejected without hitting database — prevents int4 overflow from surfacing as 500 (#1777)
    - Both user and group queries resolve before throwing — a single 400 names every invalid target (#1777)
    - Empty repositories bind but never gate — searchableRepositoryIds excludes them so no tool is scoped, but the turn proceeds (#1733)
    - Processing, failed, disconnected, unavailable repositories block — the gate fails closed on missing/incomplete/stale indexes (#1733)
    - A zero-item repository with degraded connector is failed, not empty — source exists but never arrived (#1733)
    - Workspace artifact routing — an editable artifact open beside chat gets PSD Data connector attached regardless of message classification ("add a dropdown" is a schema question) (#1786)
    - All editable artifacts get PSD Data, not only dataAccess === "query" — one update_workspace_artifact call away from query mode (#1786)
    - Documents never get workspace PSD Data — no sandbox, no data bridge (#1786)
    - Read-only viewers never get workspace PSD Data — editable: false means no authoring tools (#1786)
    - Workspace connector is optional — if unresolvable, turn continues with do-not-guess guidance instead of failing (#1786)
    - Three surfaces agree — router.ts, route.ts, mcp-connector.actions.ts share workspaceNeedsPsdData predicate, pinned by router.test.ts (#1786)
    - Do-not-guess guidance — when workspace-artifact turn lacks schema tools (inspect_table_schema, query_data), model must NOT invent columns (#1786)
    - Resolution 404-masks — resolveWorkspace 404-masks non-viewable objects; spoofed ?workspace= yields null and turn routes normally (#1786)
    - One resolution per request — routing resolves workspace; tool-binding reuses preloaded to avoid second contentService.get call (#1786)
    - Shared attachment wiring — useChatAttachments hook memoizes adapter, processing/failed sets, and lazy conversation-id accessor for nexus, decision-capture, and assistant-architect surfaces (#1735)
    - Conversation ID accessor must be closure-backed, never a memo dependency of the adapter — prevents runtime recreation during null→UUID transition (docs/features/nexus-conversation-architecture.md Pitfall 4)
    - Eager image upload — VisionImageAdapter starts repository upload at attach time, not send time; processing callbacks fire immediately so UI shows spinner during ingestion
    - Failed attachments are still "complete" — they carry safe error messages for the model, so failedAttachments set is required to prevent "Ready" chip on failed uploads
    - Document adapters sanitize errors — toSafeErrorMessage returns controlled strings for LLM context; raw server errors never cross chat boundary (OWASP LLM Top 10)
    - Generated image bucket resolver is separate from generic S3 client — getGeneratedImageBucket() reads DOCUMENTS_BUCKET_NAME directly; storeImageInS3 and resolvePreviousGeneratedImageReferences must use the same bucket (#1804)
    - Generated images use key prefix v2/generated-images/{conversationId}/ — only keys under this prefix are readable for edits, preventing cross-conversation access (#1804)
    - Edit-after-persistence reads by S3 key, not presigned URL — presigned URLs expire after one hour; edits work indefinitely by hydrating image bytes from durable storage (#1804)
  validation_commands:
    - bun run typecheck
    - bun run lint
  test_paths:
    - tests/unit/lib/nexus/conversation-repository-empty-project-gate.test.ts
    - tests/unit/api/nexus/image-generation-handler.test.ts
    - tests/unit/repository-readiness.test.ts
    - tests/e2e/nexus-project-empty-repository-chat.functional.spec.ts
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
    - tests/e2e/atrium-publish-share.functional.spec.ts
    - tests/unit/atrium-live-state.test.ts
    - tests/unit/atrium-publish-service.test.ts
    - tests/unit/atrium-publish-document-action.test.ts
    - tests/unit/atrium-workspace-change-refresh.test.tsx
    - tests/unit/nexus-workspace-change-signal.test.tsx
    - tests/unit/nexus-tool-group-workspace-signal.test.tsx
    - tests/unit/lib/content/atrium-data-contract.test.ts
    - tests/unit/lib/nexus/chat-step-budget.test.ts
    - tests/unit/lib/nexus/workspace-chat-tools.test.ts
    - tests/unit/lib/nexus/workspace-routing-context.test.ts
    - tests/unit/lib/nexus/workspace-routing-contract.test.ts
    - tests/unit/nexus-mcp-popover-workspace-connector.test.tsx
    - tests/e2e/nexus-workspace-artifact-refresh.spec.ts
    - tests/e2e/atrium-sandbox-script-order.spec.ts
    - tests/smoke/atrium-artifact-sandbox-host.smoke.ts
---

# Core Application Features

AI Studio provides five major feature areas for K-12 educators and students, all accessible through the authenticated application at `/app/(protected)`.

## Nexus Chat

**Location**: `/app/(protected)/nexus/`

Conversational AI interface with automatic model routing, MCP tool integration, and conversation management.

### Automatic Model Routing

Nexus defaults to **Standard** mode where the server classifies each request and automatically selects the appropriate model:

1. **Resolve workspace** BEFORE classification — if a workspace artifact is open beside chat, this affects routing (#1786)
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
- Real-time streaming responses with SSE keep-alive

**Streaming Reliability**: Long-running AI turns use SSE keep-alive to prevent ALB idle timeout during silent reasoning phases. Provider adapters automatically inject `: keep-alive\n\n` comment frames at 15-second intervals. See **[architecture/streaming.md](../architecture/streaming.md)** for implementation details.

**Critical**: Read `/docs/features/nexus-conversation-architecture.md` before modifying any conversation code. This system has broken multiple times—follow documented patterns exactly.

#### Repository Readiness Gate

Every model turn reloads conversation ownership, repository ACLs, lifecycle, and active-generation readiness. The search tool (`searchConversationRepositories`) is offered only for repositories that can actually serve results — scoped to `searchableRepositoryIds`, not the full bound set.

**Readiness States** (from `/lib/repositories/readiness-service.ts`):

| State | Behavior |
|-------|----------|
| `searchable` | Has serving snapshot, retrieval available |
| `degraded` | Has serving snapshot with connector issues, retrieval available |
| `empty` | **Passes**: Zero items, nothing pending/failed — binds but never gates (#1733) |
| `processing` | **Blocks**: Items mid-ingestion, index incomplete |
| `failed` | **Blocks**: Active items without serving snapshot, or degraded connector with no items |
| `disconnected` | **Blocks**: All connectors revoked |
| `unavailable` | **Blocks**: Every item taken down (quarantine, manual removal) — content existed and is gone |

**Empty Repository Exception (#1733)**: A repository with zero items, nothing pending, and nothing failed carries no stale index, so searching it is a no-op. This is what makes a brand-new Nexus project chattable before any document is uploaded:

- Project creation auto-provisions a private "project files" repository with zero items
- Before #1733, the readiness gate rejected every turn with `REPOSITORY_NOT_READY`
- Now the repository binds and is excluded from `searchableRepositoryIds` (no tool scoped to it)
- The turn proceeds; searching returns zero results instead of blocking

A zero-item repository with a **degraded connector** is `failed`, not `empty` — the source exists but never arrived, so it stays behind the gate.

**Key Sources**:
- `/lib/repositories/readiness-service.ts` — `blocksRepositorySearch()`, `selectSearchableRepositoryIds()`
- `/lib/nexus/conversation-repository-service.ts` — `ValidatedConversationRepositoryContext.searchableRepositoryIds`
- `/app/api/nexus/chat/route.ts` — `buildProjectSearchTools()`

**Focused Tests**:
- `tests/unit/lib/nexus/conversation-repository-empty-project-gate.test.ts` — empty project repository passes gate
- `tests/unit/repository-readiness.test.ts` — `blocksRepositorySearch`, `selectSearchableRepositoryIds`
- `tests/e2e/nexus-project-empty-repository-chat.functional.spec.ts` — E2E chat with empty project repository

### MCP Integration

Model Context Protocol tools integrated via:
- `/app/(protected)/nexus/_components/chat/mcp-popover.tsx` — UI for tool selection
- `/lib/mcp/tool-handlers.ts` — Server-side tool execution

Tools are gated by user capabilities and resource access grants.

### Image Generation

Nexus supports AI image generation through OpenAI (DALL-E) and Google Gemini models. The automatic model router classifies image generation requests and routes to the appropriate provider.

**Supported Operations**:
- **Generate**: Create images from text prompts
- **Edit**: Modify existing generated images with new prompts
- **Variations**: Generate variations of existing images (provider-dependent)

#### Storage and Retrieval

Generated images are stored in the configured documents bucket (`DOCUMENTS_BUCKET_NAME`) with the key pattern `v2/generated-images/{conversationId}/{uuid}.{ext}`. The system uses a dedicated bucket resolver (`getGeneratedImageBucket()` from `/lib/ai/generated-image-bucket.ts`) instead of the generic S3 client because the database `S3_BUCKET` setting is not guaranteed to match `DOCUMENTS_BUCKET_NAME`.

**Why this matters**: The generic S3 client resolves its bucket from the database setting, which may differ from the generated-images bucket. Using a dedicated resolver ensures image storage and retrieval always target the same location (`storeImageInS3` and `resolvePreviousGeneratedImageReferences` must agree).

#### Edit-After-Persistence (#1804)

Generated images can be edited hours or days after creation, not just within the current session. This works by reading previous images from S3 by their durable key instead of relying on the presigned `imageUrl` stored in the message.

**The Problem**: Presigned URLs expire one hour after generation. When a user returned 18 hours later and tried to edit a generated image, every edit request failed with HTTP 500 because the system tried to fetch the expired presigned URL from S3, which returned 403 Forbidden.

**The Fix**: `resolvePreviousGeneratedImageReferences()` (from `/app/api/nexus/chat/image-generation-handler.ts`) reads previous generated images directly from S3 using their stored `s3Key` instead of the expired `imageUrl`. This hydrates the image bytes fresh for each edit request, making edits work indefinitely.

**Security**: Only images under the conversation's own generated-images prefix (`v2/generated-images/{conversationId}/`) are readable. Keys outside this prefix point to another conversation's images and are rejected before any S3 read (enforced by `isGeneratedImageKeyForConversation`).

**Key Sources**:
- `/lib/ai/generated-image-bucket.ts` — Bucket resolver for generated images
- `/lib/ai/image-generation-service.ts` — Provider-agnostic image generation with S3 storage
- `/app/api/nexus/chat/image-generation-handler.ts` — Nexus integration, edit-after-persistence logic, reference hydration
- `/app/api/nexus/chat/route.ts` — Routing classification for image generation

**Focused Tests**:
- `tests/unit/api/nexus/image-generation-handler.test.ts` — Handler behavior including reference hydration

### Attachments (#1735)

File attachments (documents and images) are handled through a unified adapter system shared across Nexus, decision capture, and Assistant Architect. The system supports both inline content and repository-backed canonical references.

**Unified Attachment Hook**: `useChatAttachments` from `/lib/attachments/use-chat-attachments.ts` provides shared wiring for every assistant-ui composer:
- Memoized repository-backed adapter with stable dependencies
- Processing-spinner state management (`processingAttachments` set)
- Failed-upload tracking (`failedAttachments` set) — prevents "Ready" chip on failed attachments
- Lazy conversation-id accessor (closure-backed, never a memo dependency)
- Automatic upload-failure toasts (session expiry shows sign-in action)

**Adapter Implementations** (from `/lib/attachments/chat-attachment-adapters.ts`):

| Adapter | Purpose | Features |
|---------|---------|----------|
| `HybridDocumentAdapter` | PDF, DOCX, XLSX, TXT, CSV, JSON, etc. | Server-side processing with 500MB limit; magic-byte validation; safe error messages for LLM context |
| `VisionImageAdapter` | JPEG, PNG, WebP, GIF | Base64 inline for vision models; 20MB limit; optional repository canonical reference |
| `CompositeAttachmentAdapter` | Combines multiple adapters | `createEnhancedNexusAttachmentAdapter()` for Nexus; `createDocumentAttachmentAdapter()` for Assistant Architect (images excluded) |

**Repository-Backed Mode**: When `repositoryBacked: true`, uploads go through `uploadTemporaryAttachment` and return an opaque marker (e.g., `[[repository-attachment:v1:...]]`) that the AI model sees instead of raw file content. This preserves privacy and enables consistent retrieval from the repository service.

**Eager Upload**: Image uploads start at attach time (not send time), so 2+ minute repository ingestion doesn't freeze the composer. Processing callbacks fire immediately so the UI shows spinners.

**Adapter Configuration**:
- `purpose` — Product surface attribution (`"nexus"` or `"assistant-architect"`)
- `getConversationId` — Lazy accessor for conversation binding (must NOT be a memo dependency; see docs/features/nexus-conversation-architecture.md Pitfall 4)
- `repositoryBacked` — Enable canonical reference mode

**Critical**: Read `/docs/features/nexus-conversation-architecture.md` Pitfall 4 before modifying attachment adapter memoization. The conversation ID accessor must be closure-backed, not a dependency, or runtime recreation breaks streaming.

**Key Sources**:
- `/lib/attachments/chat-attachment-adapters.ts` — Adapter implementations
- `/lib/attachments/use-chat-attachments.ts` — Shared hook for attachment wiring
- `/components/assistant-ui/attachment.tsx` — Attachment UI primitives
- `/components/assistant-ui/thread.tsx` — Processing-spinner rendering

**Focused Tests**:
- `tests/unit/document-attachment-adapter.test.ts` — Document adapter validation
- `tests/components/composer-add-attachment-capability.test.tsx` — Composer integration
- `tests/e2e/assistant-architect-attachment.functional.spec.ts` — E2E attachment flow for Assistant Architect
- `tests/unit/lib/attachments/chat-attachment-adapters.test.ts` — Adapter behavior (719 lines)
- `tests/unit/lib/attachments/use-chat-attachments.test.ts` — Hook contract (123 lines)

### Workspace Chat Editing (#1087)

When an Atrium document or artifact is open beside the chat (`?workspace=<id>`), Nexus can read and edit that object directly — the "re-prompt via adjacent chat" workflow where "add a section about X" or "change the button color" acts on the panel, not just the chat.

**How it works**:
1. Client sends `workspaceId` on each chat request (via ref so opening/closing/switching mid-conversation always sends current value)
2. Server resolves workspace object through `contentService.get` BEFORE classification — resolution is reused for tool binding (#1786)
3. Server builds AI SDK tools for THAT object and injects system-prompt context (server-side, never from client tool list)
4. Object resolution 404-masks non-viewable objects — spoofed `?workspace=` yields null and turn routes normally

#### Workspace Artifact PSD Data Routing (#1786)

When an **editable artifact** is open beside the chat, the PSD Data connector is auto-attached regardless of how the user's message classifies. A follow-up like "add a school dropdown" asked of a live dashboard is a schema question wearing a UI question's clothes — without the data tools, the model invents column names and silently breaks working dashboards.

**Routing Rule** (`workspaceNeedsPsdData` in `lib/nexus/workspace-routing-contract.ts`):
- **Editable artifacts** → PSD Data connector always attached (not just `dataAccess === "query"`)
- **Documents** → Never attached (no sandbox, no data bridge)
- **Read-only viewers** → Never attached (`editable: false` means no authoring tools)

**Why all editable artifacts**: An artifact is one `update_workspace_artifact` call away from `query` mode, and "make this chart use real data" is exactly the turn that flips it — gating on current mode would leave that critical turn blind.

**Connector is optional**: The workspace connector is NOT required — if it can't be resolved or connected, the turn continues with do-not-guess guidance instead of failing. Access control, a downed MCP server, and skill `allowed-tools` pins all bite after routing, so the system degrades gracefully.

**Do-Not-Guess Guidance**: When a workspace-artifact turn ends up without schema-revealing tools (`inspect_table_schema`, `query_data`), the system appends `WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE` (from `lib/nexus/workspace-routing-contract.ts`):
> PSD DATA TOOLS ARE NOT AVAILABLE ON THIS TURN: you have no way to list tables, inspect a schema, or run a query. Do NOT guess table or column names...

The model must keep existing SQL unchanged and ask the user how to proceed rather than inventing schemas.

**Connect Popover Display**: In Advanced mode, the Connect popover renders the PSD Data connector as ON and locked when a workspace artifact is open — the user cannot switch it off because the router attaches it regardless of their toggle. The row shows "On for this workspace" and clicking explains why it stays on. Counter and row agree by using the same `isAutoAttachedForWorkspace` predicate (gated on `connected` status so expired tokens show Reconnect instead of a false "On").

**Resolution Reuse**: The workspace object is resolved once before classification (for routing) and reused for tool binding via `preloaded` param — avoiding a second `requesterForUserId` + `contentService.get` per turn.

**Key Sources**:
- `/lib/nexus/workspace-routing-contract.ts` — Routing predicates: `workspaceNeedsPsdData()`, `workspacePsdDataToolsMissing()`, `withPsdDataConnectorLast()`, `reconnectableConnectorIds()`
- `/lib/nexus/workspace-routing-context.ts` — `resolveWorkspace()` for routing, `ResolvedWorkspace` interface
- `/lib/nexus/model-router/router.ts` — Takes `workspace` param, returns `workspacePsdDataConnectorId`
- `/lib/nexus/model-router/workspace-auto-connector.ts` — `previewWorkspaceAutoConnectorIds()` for UI popover
- `/actions/mcp-connector.actions.ts` — `getConnectorsWithStatus({ workspaceId })` returns `autoAttachedForWorkspace`
- `/app/(protected)/nexus/_components/chat/mcp-popover.tsx` — Renders auto-attached connectors as on/locked

**Focused Tests**:
- `tests/unit/lib/nexus/workspace-routing-contract.test.ts` — Routing predicates
- `tests/unit/lib/nexus/workspace-routing-context.test.ts` — Workspace resolution logic
- `tests/unit/nexus-mcp-popover-workspace-connector.test.tsx` — Popover rendering for workspace auto-attached
- `tests/e2e/nexus-workspace-psd-data-connector.functional.spec.ts` — E2E (gated) popover behavior

**Bound Tools**:

| Tool | When | Effect |
|------|------|--------|
| `read_workspace_content` | viewable object | Returns title/kind/body; for artifacts also returns `dataAccess` mode. **Paged**: one call returns at most 96 KiB (`byteOffset`/`totalBytes`, plus `hasMore` + `nextOffset` when more remains) — model pages with `offset: nextOffset` until `hasMore` is absent |
| `edit_workspace_document` | editable document | §28.3-screens markdown, writes via agent bridge — appears **live** in panel |
| `update_workspace_artifact` | editable artifact | Creates new version via `contentService.createVersion`; optional `dataAccess` sets mode |

A view-only caller gets only the read tool; an unviewable `?workspace=` yields no tools (bad param never breaks chat).

**Live-Data Artifacts (#1749)**: The chat now understands the `window.AtriumData` bridge:
- `read_workspace_content` returns `dataAccess` for artifacts so the model knows which operations are allowed
- `update_workspace_artifact` can change the mode alongside the code
- `lib/content/atrium-data-contract.ts` holds the ONE copy of `DATA_ACCESS_DESC` and `ATRIUM_DATA_AUTHORING_GUIDANCE`, imported by both MCP and workspace tools

**Paged Reads (#1770)**: `read_workspace_content` never truncates or hits a hard-cap:
- One call returns at most 96 KiB (~24k tokens) with `byteOffset` and `totalBytes`
- When more remains, the result includes `hasMore: true` and `nextOffset` — the model calls again with `offset: nextOffset` and concatenates pages until `hasMore` is absent
- Previous 512 KiB cap (a *write* limit doing double duty) either blew a 128k context window in one tool result or silently truncated, making rewrites from partial content dangerous
- Page edges land on UTF-8 character boundaries — concatenated pages reproduce the source byte-for-byte with no replacement characters at seams
- A partial read is explicitly flagged as unsafe to rewrite from, because everything past that slice would be deleted

**Step Budget**: A build turn explores data before writing code, so `lib/nexus/chat-step-budget.ts` raises `maxSteps` to 20 when workspace tools are bound; every other multi-step path keeps 10.

**Panel Refresh Without Reload**: When a mutating workspace tool result lands, the Nexus tool-call renderer fires `atrium:workspace-changed` (a DOM event). `WorkspacePanel` alone subscribes, refetches its loader (where pinned `dataAccess` comes from), then bumps `ArtifactCanvas.refreshSignal`. Two independent subscribers would race; one owner ensures consistent order.

**Key Sources**:
- `/docs/features/nexus-workspace-chat-editing.md` — full documentation
- `/lib/nexus/workspace-chat-tools.ts` — tool definitions
- `/lib/atrium/workspace-change-event.ts` — DOM event contract
- `/app/(protected)/nexus/_components/tools/use-workspace-change-signal.ts` — hook for emitting events

**Focused Tests**:
- `tests/unit/lib/nexus/workspace-chat-tools.test.ts` — gating, read vs edit, `dataAccess` read/set, pagination and UTF-8 boundary safety
- `tests/unit/lib/nexus/chat-step-budget.test.ts` — step budget derivation
- `tests/unit/atrium-workspace-change-refresh.test.tsx` — panel refresh on signal
- `tests/unit/nexus-workspace-change-signal.test.tsx` — signal emission from tool calls
- `tests/e2e/nexus-workspace-artifact-refresh.spec.ts` — end-to-end refresh without reload

### Key Source Files

| File | Purpose |
|------|---------|
| `/lib/nexus/model-router/router.ts` | Automatic model routing logic |
| `/lib/nexus/model-router/classifier.ts` | Intent classification |
| `/lib/nexus/model-router/psd-data-connector.ts` | Shared PSD Data MCP server resolution (used by Nexus and Atrium artifact queries) |
| `/lib/nexus/workspace-routing-contract.ts` | Workspace artifact routing predicates and do-not-guess guidance (#1786) |
| `/lib/nexus/workspace-routing-context.ts` | Workspace object resolution for routing (#1786) |
| `/lib/nexus/model-router/workspace-auto-connector.ts` | Preview of auto-attached connectors for UI (#1786) |
| `/lib/nexus/history-adapter.ts` | Conversation history management |
| `/lib/attachments/chat-attachment-adapters.ts` | File attachment handling (documents, images) |
| `/lib/attachments/use-chat-attachments.ts` | Shared attachment wiring hook for Nexus, decision capture, and Assistant Architect (#1735) |
| `/lib/nexus/workspace-chat-tools.ts` | Workspace panel editing tools |
| `/lib/nexus/chat-step-budget.ts` | Multi-step budget (10 vs 20 steps) |
| `/lib/atrium/workspace-change-event.ts` | DOM event for panel refresh |
| `/app/(protected)/nexus/_components/tools/use-workspace-change-signal.ts` | Hook to emit workspace change events |
| `/actions/mcp-connector.actions.ts` | Connector status with workspace auto-attach flag (#1786) |
| `/app/(protected)/nexus/_components/chat/mcp-popover.tsx` | Connect popover UI with workspace-aware rendering (#1786) |

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

### Prompt Chain Streaming

**Problem**: Prompt chains run every prompt except the last to completion before building the streaming Response for the final one. A slow earlier prompt would leave the socket with no bytes at all, triggering ALB idle timeout after 300 seconds (#1698).

**Solution**: The execution endpoint uses `deferUIMessageStreamResponse()` to wait a grace period for the real Response. If not ready in time, it commits to a 200 SSE response immediately with keep-alive comments, then streams the real body once it exists.

**Key Files**:
- `/app/api/assistant-architect/execute/route.ts` — Uses `deferUIMessageStreamResponse`
- `/lib/api/assistant-execution-service.ts` — Execution service integration
- `/lib/streaming/deferred-ui-message-stream.ts` — Deferred response implementation

See **[architecture/streaming.md](../architecture/streaming.md#deferred-response-for-prompt-chains)** for complete architecture.

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

Content links resolve based on the conjunction of Level and Live:

- **Live + Public** → `/p/{slug}` (public reader, anonymous access)
- **Live + Internal/Private** → `/c/{slug}` (intranet reader, authenticated)
- **Draft** → `/atrium/{id}/view` or `/edit` (authoring surface, requires `canView`, renders head version)

**Derivation**: The public address is derived from Level + Live, not from a separate publication destination. An object has exactly one live publication row (`destination = 'intranet'`), and the `/p/{slug}` route gates on `visibility_level = 'public'` AND a live row.

**Exceptions**:
- Objects with `status = 'published'` but no live surface row (e.g., only an OKF export bundle) still get `/c/{slug}` — the known mismatch case
- Connector destinations (`schoology`, `google`) have no reader URL — they push copies to external systems

The `contentSurfaceLink()` function handles this routing automatically. This fix resolved dead links for unpublished content (e.g., psd-morning-brief artifacts that are never published) where the reader link would 404 for both recipients and owners.

**Key Source**: `derivedReaderUrl()` in `/lib/content/publish-service.ts` returns `/p/{slug}` for public objects, `/c/{slug}` otherwise — relayed verbatim to prevent dead links.

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

### Publication Model: Live/Draft + Level

**Publication is a single Live/Draft state** — not a destination choice. The Level alone decides who can read the content:

- **Private** — Only author and administrators (plus any preserved user grants)
- **Internal** — Staff with visibility grants (specific users, groups, roles, buildings, departments, grades)
- **Public** — Anyone with the link, including anonymous visitors

**Reader URLs are derived from Level + Live**:
- **Draft** → `/c/{slug}` (authoring surface, requires authentication)
- **Live** → `/c/{slug}` for Internal/Private, `/p/{slug}` for Public
- The public address `/p/{slug}` resolves only when object is **Public AND Live**

**Publishing does NOT change audience** — it only pins a version, makes content live and discoverable, and adds it to retrieval. The Level decides who can open it. This removes the previous "Widen who can see this?" prompt which was false and destructive.

**Migration 180** (#1726): Existing live `public_web` rows were folded into live `intranet` rows. Objects that were Level=Public but only published to intranet became anonymously readable at `/p/{slug}` (the deploy widened exposure before the migration ran). Migration also filed `publicExposure` audit rows for objects newly exposed by the deploy.

**§26.4 Public-publish gate** now applies to:
1. Widening an object to `public` level (requires `content:publish_public` scope)
2. Publishing to connector destinations (`schoology`, `google`)
3. Publishing live for an object whose level is already `public`

Making an object live is **not** gated — it changes only state, not audience.

**Key Sources**:
- `/docs/features/atrium-design-spec.md` §26.4 — gate explained
- `/lib/content/live-publication.ts` — shared "is this live?" predicate
- `/infra/database/schema/180-atrium-single-live-publication.sql` — migration with full context
- `/lib/content/publish-service.ts` — publish service implementation
- `/actions/db/atrium/publish-document.ts` — server action

**Focused Tests**:
- `tests/e2e/atrium-publish-share.functional.spec.ts` — end-to-end Live/Draft switch
- `tests/unit/atrium-live-state.test.ts` — live predicate and consequence lines
- `tests/unit/atrium-publish-service.test.ts` — publish service unit tests
- `tests/unit/atrium-publish-document-action.test.ts` — action tests

### Visibility & Grant Management (#1763)

**Sources**: `/lib/content/visibility-read.ts`, `/lib/agent-workspace/atrium-owner-operation.ts`, `/app/api/v1/content/[id]/visibility/route.ts`, `/infra/agent-image/skills/psd-atrium/SKILL.md`

Atrium objects have both a **visibility level** (who can access) and a **grant list** (specific principals). Agents and API callers must understand both to manage audience safely.

#### Visibility Levels

- **Private** — Only author and administrators (plus any preserved user grants)
- **Group** — Staff matching ANY grant entry (union of all grants)
- **Internal** — Staff with visibility grants (specific users, groups, roles, buildings, departments, grades)
- **Public** — Anyone with the link, including anonymous visitors

#### Grant Types

Each grant is `kind:value` where `kind` determines the value format:

| Kind | Value Format | Example |
|------|--------------|---------|
| `role` | Role name | `role:staff` |
| `building` | Building code | `building:GHS` |
| `department` | Department name | `department:Curriculum` |
| `grade` | Grade level | `grade:12` |
| `group` | Group email address | `group:cabinet@psd401.net` |
| `user` | Numeric user ID (NOT email) | `user:42` |

**Critical**: `user` grants require the numeric AI Studio user ID. Email addresses are rejected with a 400. This skill cannot resolve an email to an ID—use the web visibility editor's people picker for named individuals.

#### Grant Target Existence Validation (#1777)

**Source**: `/lib/content/grant-targets.ts`

Both object-level grants (`content_visibility_grants`) and collection-level grants (`content_collection_grants`) now validate that `user` and `group` targets exist before storing. Previously, grants naming non-existent users or unsynced groups were accepted, stored, and echoed back by read surfaces while authorizing nobody — the only symptom was a reader getting a 404 on content they appeared to be granted.

**Scope**: Only `user` and `group` are existence-checked; `role` matches by NAME (not numeric id), and `building`/`department`/`grade` are free-text user attributes with no canonical list.

**Validation behavior**:
- `user` grants: Value must be an existing `users.id` (int4 range). Out-of-range IDs (>2147483647) are rejected without hitting the database. Google directory personIds (21-digit) are explicitly rejected with a message pointing at the correct `users.id` field.
- `group` grants: Value must match a synced `groups.group_email` (case-insensitive `lower()` comparison, matching the read path). Groups not yet ingested by the sync are rejected with a message pointing at Admin → Groups pick rules.
- Both kinds resolve before any error is thrown, so one rejection names every invalid target — callers (usually agents retrying unattended) see the complete fix in one 400 response.

**Error messages are actionable**:
- Unknown user id: Points to `users.id` vs Google personId distinction
- Group not synced: Points to Admin → Groups `pick` rule and hourly sync cadence

**Key Sources**:
- `/lib/content/grant-targets.ts` — `assertGrantTargetsExist()` shared by both grant paths
- `/lib/content/visibility-service.ts` — `applyGrantsInTx` calls the check after normalization
- `/lib/content/collection-management-service.ts` — `replaceGrants` calls the check before delete-then-insert
- `/docs/API/v1/context-graph.md` — API contract documentation

**Focused Tests**:
- `tests/unit/atrium-visibility.test.ts` — object-level grant target existence block
- `tests/unit/atrium-collection-management.test.ts` — collection-level grant target existence block

#### Replace vs. Merge Mode

**Replace mode** (`--grants`):
- REPLACES the entire grant list — does not append
- Read-first rule: Call `read-grants` before `set-visibility --grants` to avoid destroying access
- Required when you want the list to be EXACTLY what you pass

**Merge mode** (`--add-grants`, `--remove-grants`):
- Reads the stored list, applies the change, writes the union
- Keeps the object's current level unless `--level` is also passed
- Deduplicates by `kind:value` — safe to re-run
- Fails with actionable error for non-group objects (grants apply only to `level: group`)

#### Read Grants Before Modifying

The `read-grants` command returns the level plus the actual grants array:

```bash
# Agent skill
node run.js read-grants --id <uuid-or-slug>

# REST v1 API
GET /api/v1/content/:id/visibility
```

**Editor gate**: Grant reads require EDIT permission, not just VIEW. The grant list names every principal with access, so someone who can merely view an object cannot enumerate its audience. This prevents information disclosure (e.g., exposing user IDs behind `user` grants).

**Shared implementation**: The agent broker, REST v1 API, and MCP `get_visibility` tool all use `readVisibilityForEdit()` from `/lib/content/visibility-read.ts`, ensuring authorization and response shape stay identical across surfaces.

**Why this matters**: Before #1763, `read` and `get_content` returned only `grantCount` (an integer). An agent narrowing or widening an object had to guess the grant list, and a wrong guess silently revoked access with no audit trail to restore it. The `read-grants` command, `get_visibility` MCP tool, and merge mode eliminate this hazard.

**Key Sources**:
- `/lib/content/visibility-read.ts` — shared grant-read helper
- `/lib/mcp/content-tool-handlers.ts` — MCP `get_visibility` handler (#1763, #1769)
- `/lib/agent-workspace/atrium-owner-operation.ts` — agent broker `GET /<id>/visibility`
- `/app/api/v1/content/[id]/visibility/route.ts` — REST v1 GET endpoint
- `/infra/agent-image/skills/psd-atrium/SKILL.md` — skill documentation

**Focused Tests**:
- `tests/unit/atrium-visibility-read.test.ts` — shared helper behavior
- `tests/unit/atrium-mcp-get-visibility-handler.test.ts` — MCP handler (#1763, #1769)
- `tests/unit/atrium-content-visibility-read-route.test.ts` — REST v1 route
- `tests/unit/agent-atrium-owner-operation.test.ts` — broker branch
- `tests/e2e/atrium-content-api.functional.spec.ts` — grant round-trip and denial shapes

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

### Script Execution Order and Lifecycle Events (#1785)

The Atrium sandbox host guarantees deterministic script execution order and fires synthetic lifecycle events after all scripts complete. This fixes the "Chart is not defined" regression where inline code ran before its preceding CDN library.

**Execution Guarantees**:

| Guarantee | Behavior |
|-----------|----------|
| **Document order** | Scripts execute in markup order, not force-async |
| **External await** | Inline code waits for preceding `<script src>` to load before running |
| **Synthetic lifecycle** | `DOMContentLoaded` and `load` fire exactly once after all scripts complete |
| **Failed scripts don't block** | A blocked or failing external script fires `error` and the chain continues |
| **Non-executable skipped** | `<script type="text/template">`, `<script nomodule>` never stall chain |
| **Deadline bounded** | Total wait time bounded at 90s; past deadline, remaining scripts insert without waiting |

**Authoring Pattern**: An artifact can now structure scripts naturally:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
  // Inline code that depends on Chart — runs after library loads
  new Chart(ctx, config);
</script>
<script>
  // Bootstrap from DOMContentLoaded — fires once after above scripts
  document.addEventListener("DOMContentLoaded", () => init());
</script>
```

**Superseded Chains**: When a new render arrives while an earlier chain is still waiting on a CDN, the stale chain is abandoned and its lifecycle listeners are unregistered. This prevents double-initialization and duplicate side effects (e.g., `AtriumData.submit` firing twice).

**Duplicate Renders**: The parent re-posts the same code until acked. A duplicate post while a CDN is in flight is acknowledged without re-rendering — the library and inline code each run exactly once.

**Key Sources**:
- `/infra/sandbox-host/render.html` — `executeScripts()` chain with ordering, timeout, and lifecycle dispatch
- `/infra/lib/atrium-sandbox-host-page.ts` — Extracted CSP builder and page renderer shared by stack and tests
- `/lib/content/atrium-data-contract.ts` — `ATRIUM_DATA_AUTHORING_GUIDANCE` includes script timing note

**Focused Tests**:
- `/tests/e2e/atrium-sandbox-script-order.spec.ts` — Chromium tests for real browser behavior (force-async interleave, lifecycle events)
- `/tests/smoke/atrium-artifact-sandbox-host.smoke.ts` — jsdom smoke with extended #1785 test cases

### Shared Data Contract (#1749)

The `AtriumData` bridge contract is defined in `/lib/content/atrium-data-contract.ts` and shared across all artifact-authoring surfaces:

- **`DATA_ACCESS_DESC`** — What the three modes mean (imported by both MCP content tools and workspace chat tools)
- **`ATRIUM_DATA_AUTHORING_GUIDANCE`** — How to write artifact code against the bridge (the operations, return shapes, authoring rules, and script timing guarantees: document-order execution, external script await, synthetic `DOMContentLoaded`/`load`)

**Why shared**: Before #1749, the workspace chat knew nothing about the bridge. A "build me a live dashboard" request worked through MCP tools and failed in workspace chat — the model was never told `window.AtriumData` existed, invented a helper, saw it fail, and baked a stale snapshot into the source.

**Synchronization required**: The `psd-atrium` agent skill keeps a hand-maintained Markdown copy of the same guidance (`infra/agent-image/skills/psd-atrium/SKILL.md`, "Live PSD data inside an artifact" section). Editing `atrium-data-contract.ts` does NOT update the skill automatically — change both when the contract changes.

### Workspace Change Event (#1749)

When a Nexus workspace tool mutates the open object, the panel must refresh. A DOM event provides this communication without coupling:

**Event**: `atrium:workspace-changed` (`CustomEvent` dispatched on `window`)

**Why DOM event** (not React context or conversation subscription):
- `WorkspacePanel` and `ArtifactCanvas` are pure layout siblings of the Nexus conversation tree
- They must stay completely unaware of the conversation runtime (see `/docs/features/nexus-conversation-architecture.md`)
- A DOM event lets the tool surface tell them "refetch" without either side importing the other

**One refresh owner**: `WorkspacePanel` alone subscribes. It:
1. Re-runs `loadWorkspacePanelAction` (where pinned `dataAccess` comes from)
2. Then bumps `ArtifactCanvas.refreshSignal` (reloads version list and head)

Two independent subscribers would race — whichever fetch landed first would render mixed state, and a panel fetch that failed while the canvas succeeded would pin the new code to the OLD mode.

**Emission rules**:
- Fires ONCE per tool call (tracked by `toolCallId`)
- Only for calls observed going from "running" to "resolved" (not history replay)
- Only for mutating tools (`update_workspace_artifact`, `edit_workspace_document`, `publish_workspace_content`, `unpublish_workspace_content`)
- Never for error results
- Scopes by `objectId` when the result carried one

**Key Sources**:
- `/lib/atrium/workspace-change-event.ts` — event contract (`emitWorkspaceChanged`, `onWorkspaceChanged`, `workspaceChangeMatches`)
- `/app/(protected)/nexus/_components/tools/use-workspace-change-signal.ts` — hook for tool-group emission

**Focused Tests**:
- `tests/unit/atrium-workspace-change-refresh.test.tsx` — panel refresh on signal
- `tests/unit/nexus-workspace-change-signal.test.tsx` — emission from tool results
- `tests/unit/nexus-tool-group-workspace-signal.test.tsx` — tool-group integration
- `tests/e2e/nexus-workspace-artifact-refresh.spec.ts` — end-to-end refresh without reload

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
- `create_document`, `create_artifact` — Create content objects (private + draft by default)
- `get_content` — Read object + last saved version (returns `grantCount` integer only)
- `get_visibility` — Read visibility level + actual grant entries (#1763, #1769); requires EDIT permission on object
- `list_content` — List accessible content
- `update_content`, `create_version` — Metadata and version-based edits
- `set_visibility` — Replace grant list (call `get_visibility` first to avoid dropping access)
- `publish_content`, `unpublish_content` — Publication controls with approval gates
- `export_okf`, `import_okf` — Open Knowledge Format import/export
- Permission-aware retrieval for grounded responses

**Why `get_visibility` exists** (#1763, #1769): The `grants` parameter on `set_visibility` REPLACES the entire list — it does not append. Before #1769, MCP callers had to guess the existing grants, and a wrong guess silently revoked access. `get_visibility` lets agents read before modifying. See **[Visibility & Grant Management](#visibility--grant-management-1763)** for detailed grant types and merge mode, and **[Grant Target Existence Validation](#grant-target-existence-validation-1777)** for the existence check added in #1777.

**CSP Guidance for Artifacts** (#1750):

MCP content tools append a CSP guidance sentence to `create_artifact` and `create_version` descriptions based on the runtime environment variable `ATRIUM_ALLOWED_ARTIFACT_CDNS`. This tells artifact authors exactly which external origins they may load scripts from:

- **Non-empty allowlist** → "Inline `<script>` and `<style>` are permitted; external scripts/styles are blocked except from: [origins]"
- **Empty allowlist** → "Inline `<script>` and `<style>` are permitted; external scripts/styles are blocked"
- **Inline scripting is explicitly permitted** because leaving it ambiguous led models to assume they must load from CDN instead of using inline scripts

The guidance is sourced from `/lib/content/artifact-sandbox-config.ts` → `buildArtifactCspGuidance()` which parses `ATRIUM_ALLOWED_ARTIFACT_CDNS` from the environment. The environment variable is injected from `infra/cdk.json` → `atriumAllowedArtifactCdns`, ensuring guidance and enforcement never disagree. For infrastructure deployment details, see **[infrastructure/overview.md](../infrastructure/overview.md#atrium-sandbox-configuration)**.

**Key Sources**:
- `/lib/mcp/content-tools.ts` — MCP tool descriptions with CSP guidance
- `/lib/content/artifact-sandbox-config.ts` — CSP guidance builder
- `/lib/nexus/workspace-chat-tools.ts` — Nexus workspace artifact tool guidance

**Focused Tests**:
- `/tests/unit/atrium-mcp-content-tools.test.ts` — validates CSP guidance in tool descriptions

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
