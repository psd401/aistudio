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
    - lib/content/artifact-query-limits.ts
    - lib/content/artifact-bridge-errors.ts
    - lib/atrium/artifact-preview-diagnostics.ts
    - lib/content/grant-targets.ts
    - lib/content/visibility-service.ts
    - lib/content/collection-management-service.ts
    - lib/atrium/usage-series.ts
    - lib/atrium/recent-window.ts
    - lib/atrium/workspace-change-event.ts
    - lib/nexus/workspace-chat-tools.ts
    - lib/nexus/chat-step-budget.ts
    - app/(protected)/utilities/assistant-architect/create/_components/create-form.tsx
    - components/ui/use-toast.ts
    - components/ui/form.tsx
    - app/(protected)/nexus/_components/tools/use-workspace-change-signal.ts
    - actions/mcp-connector.actions.ts
    - app/(protected)/nexus/_components/chat/mcp-popover.tsx
    - app/(protected)/nexus/page.tsx
    - components/assistant-ui/thread.tsx
    - lib/tools/web-fetch-tool.ts
    - lib/agents/agent-tools/web-fetch.ts
    - lib/nexus/model-router/url-detection.ts
    - app/(protected)/nexus/_components/tools/web-fetch-ui.tsx
    - app/api/atrium/artifacts/[id]/query/route.ts
    - lib/content/artifact-query-transport.ts
    - lib/nexus/workspace-conversation-binding.ts
    - lib/nexus/workspace-restore-state.ts
    - lib/nexus/workspace-tool-history.ts
    - lib/nexus/draft-auto-send.ts
    - lib/content/version-author-label.ts
    - actions/nexus/workspace-binding.actions.ts
    - lib/db/schema/tables/content-versions.ts
    - lib/content/version-service.ts
    - actions/db/atrium/artifact-guards.ts
    - actions/db/atrium/get-artifact-code.ts
  invariants:
    - Artifact data_access modes (records/query/none) are mutually exclusive — prevents exfiltration loop
    - Mode is enforced twice (client-side pin + server-side check) and changes only take effect on fresh page load (#1712)
    - Version-scoped data-access — each content_versions row carries data_access mode its code was authored for (#1789)
    - Live pages pin published version's mode — author draft-mode changes never re-capability Live pages (#1789)
    - resolveVersionDataAccess is the canonical resolver — null on version falls back to object's mode (#1789)
    - Mode change on Live HEAD forks a new version — propagateDataAccessToHead never changes Live capability without republish (#1789)
    - Reader-submitted versionId is ignored — server resolves to published version; prevents mode-selection attack (#1789)
    - Editor-submitted versionId is validated — must belong to this object; foreign versions refuse (#1789)
    - Rollback restores version's mode — head stamp equals object mode invariant preserved (#1789)
    - Canvas bridge pin uses loaded version's stamp — previewing older version uses that version's mode (#1789)
    - Full-screen link from Live pins to published version — readers never see author's half-finished draft (#1789)
    - Bridge numeric limits are enforced and stated from one source — DEFAULT 200, MAX 2000, offset MAX 1M, SQL MAX 8000 chars, timeouts 30s server / 45s client — interpolated into authoring guidance so models cannot state a limit the code does not apply (#1792)
    - Bridge enabled on authoring surfaces (view page, editor canvas, workspace panel); embeds/thumbnails/public reader stay fail-closed (#1725)
    - Canvas sandbox keys on contentId:dataAccess:versionId — one mount belongs to one artifact in one mode
    - Query concurrent cap is 6 (records 1) with 32 total outstanding; excess queues rather than rejects (#1788)
    - Server budget (30s) spans preflight + MCP handshake + execution; preflight stages race deadline (#1788)
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
    - Shared data contract — DATA_ACCESS_DESC and ATRIUM_DATA_AUTHORING_GUIDANCE are imported by both MCP content tools (create_artifact/create_version) and workspace chat tools so artifact-authoring surfaces cannot drift (#1792)
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
    - Bridge failures are typed — `err.code` is one of a closed set (unauthenticated, forbidden, not_query_mode, rate_limited, timeout, query_error, too_many_requests, unavailable); wrap every AtriumData call in try/catch and branch on the code (#1787)
    - query_error message is viewer-gated — the database error message is attached only when the requester can EDIT the artifact; plain readers get the code with a generic message (#1787)
    - Error messages are bounded and flattened — multi-line Postgres errors collapse to one line; length capped at 500 characters; never grow without bound or smuggle line structure into prompts (#1787)
    - Preview diagnostics are per-artifact — the failure buffer is replaced outright when switching artifacts; stale entries from one artifact can never be reported against another (#1787)
    - Diagnostics are read once per request — takeArtifactPreviewDiagnostics clears the buffer so each failure reaches the model exactly once, never re-sent on every later turn (#1787)
    - Failed send restores diagnostics — if the request never reached the server, the taken entries are restored so the preview may re-run the failing query (#1787)
    - Fresh version clears diagnostics — clearArtifactPreviewDiagnostics is called when a new artifact version mounts so previous failures don't describe code that is no longer running (#1787)
    - web_fetch is Nexus-only — attached to every Nexus turn, never to single-step surfaces (model compare, AI helpers without multi-step budgets) (#1696)
    - Page text is fenced as untrusted — fetched content wrapped in <untrusted_web_content> markers; model must treat it as data, not instructions (OWASP LLM01) (#1696)
    - Fence markers are neutralized — the page cannot close its own fence with literal </untrusted_web_content> or whitespace variants; attempted breakouts are escaped (#1696)
    - SSRF guard blocks private hosts — loopback, link-local, unique-local IPv6, cloud-metadata addresses refused before fetch, including through redirects (#1696)
    - Redirects report final URL — a cross-host redirect attributes the content to the final destination, not the requested link (#1696)
    - Failure messages are sanitized — never echo server-controlled text (status lines, headers, error messages); only known-safe strings reach the model (#1696)
    - URL messages route as general — a pasted link classifies as general intent, never web-search, so the turn never fails for lack of a search-capable model (#1696)
    - Mixed URL + current-info still routes as web-search — "summarize <url> and give today's weather" keeps web_fetch attached; degrades to fetch-only when no search model available (#1696)
    - Minimum step budget is 3 — WEB_FETCH_MAX_STEPS ensures a follow-up step after calling web_fetch; prevents empty replies on "summarize this link" (#1696)
    - Skill allowed-tools pins can exclude web_fetch — a non-empty pin omitting web_fetch / webFetch / chat.web_fetch prevents attachment (#1696)
    - Built-in web_fetch wins on name collision — a connector exposing web_fetch cannot replace the SSRF-guarded implementation (#1696)
    - Workspace binding is owner-scoped — every query includes user_id in WHERE predicate; miss and not-yours both return null (#1791)
    - Binding write is idempotent — WHERE clause matches only when column is NULL or holds DIFFERENT id; steady state updates no rows (#1791)
    - Failed binding write is logged not fatal — turn is not aborted; only next reopen loses panel (#1791)
    - Restore flag is per-conversation — `restoreBoundWorkspace: true` sent only while pending for THIS conversation; stale settle cannot clear another conversation's flag (#1791)
    - Draft auto-send requires exact match — nonce must match stored entry for exact draft text; swapped prompt is refused (#1791)
    - Draft auto-send is one-shot — entry deleted on first read; reload/Back re-prefills (#1791)
    - Truncated draft never auto-sends — drafts >4000 chars show warning and prefill only (#1791)
    - Rename re-slugs only when never published — publication row to `unpublished` preserves "ever published" (#1791)
    - Slug collision on rename → ConflictError — SQLSTATE 23505 mapped to 409 "please retry" (#1791)
    - Mode-only update skips screening — no model-authored bytes persisted (#1791)
    - Mode-only update returns error on failure — no `ok: true` with warning (#1791)
    - Version author label is viewer-neutral — never "you"; unknown labels fall back to "human" (#1791)
    - Version-scoped data-access — each `content_versions` row carries `data_access` mode its code was authored for (#1789)
    - Live pages pin published version's mode — author draft-mode changes never re-capability Live pages (#1789)
    - resolveVersionDataAccess is the canonical resolver — null on version falls back to object's mode (#1789)
    - Mode change on Live HEAD forks a new version — propagateDataAccessToHead never changes Live capability without republish (#1789)
    - Reader-submitted versionId is ignored — server resolves to published version; prevents mode-selection attack (#1789)
    - Editor-submitted versionId is validated — must belong to this object; foreign versions refuse (#1789)
    - Rollback restores version's mode — head stamp equals object mode invariant preserved (#1789)
    - Canvas bridge pin uses loaded version's stamp — previewing older version uses that version's mode (#1789)
    - Full-screen link from Live pins to published version — readers never see author's half-finished draft (#1789)
    - Agent-maintained version shows "AI" — authorActor field "agent" wins over surface label (#1791)
    - Pruning is per-object — parts keyed by objectId; rebound conversation cannot stub another object's reads (#1791)
    - Pruning is model-side only — persisted messages and thread render unchanged (#1791)
    - Parts without objectId kept verbatim — legacy reads before objectId was returned cannot be grouped (#1791)
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
    - tests/unit/atrium-artifact-preview-diagnostics.test.ts
    - tests/e2e/atrium-sandbox-typed-errors.spec.ts
    - tests/unit/lib/nexus/chat-step-budget.test.ts
    - tests/unit/lib/nexus/workspace-chat-tools.test.ts
    - tests/unit/lib/nexus/workspace-routing-context.test.ts
    - tests/unit/lib/nexus/workspace-routing-contract.test.ts
    - tests/unit/nexus-mcp-popover-workspace-connector.test.tsx
    - tests/e2e/nexus-workspace-artifact-refresh.spec.ts
    - tests/e2e/atrium-sandbox-script-order.spec.ts
    - tests/smoke/atrium-artifact-sandbox-host.smoke.ts
    - tests/unit/assistant-architect-create-form.test.tsx
    - tests/unit/use-toast-sonner-adapter.test.ts
    - tests/e2e/assistant-architect-create-add-field.functional.spec.ts
    - tests/unit/lib/tools/web-fetch-tool.test.ts
    - tests/unit/lib/nexus/model-router/__tests__/url-detection.test.ts
    - tests/e2e/nexus-url-access.functional.spec.ts
    - tests/unit/atrium-artifact-query-route.test.ts
    - tests/unit/atrium-artifact-record-transport-failure.test.tsx
    - tests/unit/nexus-workspace-conversation-binding.test.ts
    - tests/unit/lib/nexus/draft-auto-send.test.ts
    - tests/unit/nexus-prompt-auto-loader-autosend.test.tsx
    - tests/unit/atrium-rename-reslug.test.ts
    - tests/unit/atrium-version-author-label.test.ts
    - tests/unit/atrium-snapshot-before-publish-label.test.ts
    - tests/unit/lib/nexus/workspace-tool-history.test.ts
    - tests/unit/lib/nexus/workspace-restore-state.test.ts
    - tests/unit/lib/streaming/__tests__/stream-deadline.test.ts
    - tests/e2e/atrium-live-draft-data-access.functional.spec.ts
    - tests/unit/atrium-rendered-version-data-access.test.ts
    - tests/unit/atrium-version-data-access-migration.test.ts
    - tests/unit/atrium-version-data-access-stamp.test.ts
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

### Web Fetch Tool (#1696)

Nexus chat can open a specific URL when the user pastes one. This closes a gap where the only internet-facing tool was provider-native web *search* (which finds pages but cannot fetch a given link), so "open this URL" requests previously failed with "I cannot access URLs directly."

**Scope**: Nexus chat only. The tool is NOT attached to single-step streaming surfaces (model compare, AI helpers without multi-step budgets) because `web_fetch` is non-terminal — the model calls it, then needs a follow-up step to answer from the fetched content. Attaching it to a single-step surface would end the turn at the tool result with no text reaching the user.

**Security Measures**:
- **SSRF Guard**: HTTPS-only in production; private/loopback/link-local/cloud-metadata hosts blocked, including through redirects and DNS rebinding (`/lib/agents/agent-tools/web-fetch.ts` — `isBlockedHost()`)
- **Content Fencing**: Fetched page text is wrapped in `<untrusted_web_content source="...">` markers. The tool description instructs the model to treat everything inside the fence as *data* (summarize, quote, answer from), never as permission or directions to follow (OWASP LLM01 — indirect prompt injection)
- **Fence Neutralization**: The page controls the text, so `neutralizeFenceMarkers()` escapes the `<` of any literal `</untrusted_web_content>` or `<untrusted_web_content>` in the page body — preventing a hostile page from closing its fence early and surfacing injected instructions outside the boundary
- **Redirect Attribution**: After a redirect, the tool reports the *final* URL (where content actually came from) rather than the requested URL
- **Error Message Sanitization**: Failure messages never echo server-controlled text (status lines, header values, error messages) — only known-safe strings like standard HTTP reason phrases or generic "network error (CODE)" forms

**Routing Implications**:
- A message naming a URL classifies as `general` intent, never `web-search`, because `web_fetch` is universal (attached to every Nexus turn) and needs no specialist model
- The router prefers a function-calling model for URL messages (`selectModelForToolUse`) but falls back to the normal model when none is available — refusing the link is worse
- A URL alongside current-info wording (`"summarize <url> and give today's weather"`) still routes as `web-search` with both reason codes (`current_web_information`, `explicit_url_web_fetch`), and `web_fetch` stays attached
- When no search-capable model is accessible for that mixed case, the router degrades to a fetch-only `general` turn so the link is never refused

**Step Budget**: The minimum budget for any Nexus turn is now 3 steps (`WEB_FETCH_MAX_STEPS` in `/lib/nexus/chat-step-budget.ts`) — one to fetch, one to answer, and one spare. This floor prevents a "summarize this link" turn from stopping at the tool call with no follow-up.

**Skill Pin Enforcement**: A skill with a non-empty `allowed-tools` pin that omits `web_fetch` / `webFetch` / `chat.web_fetch` will not have the tool attached. The built-in is also preserved over same-named external tools — a connector exposing `web_fetch` cannot replace the SSRF-guarded implementation.

**URL Detection** (`/lib/nexus/model-router/url-detection.ts`):
- `containsExplicitUrl(text)` — Detects http(s) URLs in the message, including bracketed IPv6 hosts
- `stripExplicitUrls(text)` — Removes URLs for the current-info wording check, preventing `https://example.com/latest-news/` from triggering the web-search branch

**Key Sources**:
- `/lib/tools/web-fetch-tool.ts` — AI SDK tool implementation, content fencing, fence neutralization
- `/lib/agents/agent-tools/web-fetch.ts` — Core `fetchWebPageText()` with SSRF guards, redirect validation, error sanitization
- `/lib/nexus/model-router/classifier.ts` — URL detection in deterministic classification
- `/lib/nexus/model-router/url-detection.ts` — Shared URL detection patterns
- `/lib/nexus/chat-step-budget.ts` — `WEB_FETCH_MAX_STEPS` floor
- `/app/api/nexus/chat/route.ts` — `buildMergedChatTools()` attachment logic
- `/app/(protected)/nexus/_components/tools/web-fetch-ui.tsx` — Tool UI card showing which page was opened

**Focused Tests**:
- `tests/unit/lib/tools/web-fetch-tool.test.ts` — 34 test cases covering tool behavior, fencing, neutralization, error handling
- `tests/unit/lib/nexus/model-router/__tests__/classifier.test.ts` — URL routing classifier tests
- `tests/unit/lib/nexus/model-router/__tests__/url-detection.test.ts` — URL detection patterns including IPv6
- `tests/unit/lib/nexus/model-router/__tests__/router.test.ts` — Model selection preferences for URL messages
- `tests/unit/lib/nexus/chat-step-budget.test.ts` — Step budget floor tests
- `tests/e2e/nexus-url-access.functional.spec.ts` — E2E test for URL opening flow

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

#### Workspace Object Binding (#1791)

A conversation opened beside an Atrium document or artifact records that object durably in `nexus_conversations.workspace_object_id` (migration 183). Before this, the binding lived ONLY in the `?workspace=` URL param — reopening from the sidebar showed chat without the panel, and "Ask the agent" always started a new conversation.

**Binding Operations** (`lib/nexus/workspace-conversation-binding.ts`):

| Operation | When | Owner Scope |
|-----------|------|-------------|
| `bindConversationWorkspace` | Every turn with workspace bound | `user_id` in WHERE predicate |
| `getConversationWorkspaceObjectId` | Reopening conversation without `?workspace=` | `user_id` in WHERE predicate |
| `findLatestConversationForWorkspace` | "Ask the agent" / "Open beside chat" | `user_id` in WHERE predicate |
| `workspaceIdForTurn` | Server-side during restore window | Reads persisted binding only when `restoreBoundWorkspace: true` |

**Security**: Every query includes `user_id` in the WHERE clause — never by a prior read. A conversation is private to the person who had it, and this binding cannot expose whether a conversation ID exists or who else worked on an artifact.

**Restore Flow**:
1. Opening `/nexus?id=...` without `?workspace=` triggers `useRestoreBoundWorkspace` (async lookup)
2. Client posts `restoreBoundWorkspace: true` in request body while restore pending
3. Server reads persisted binding via `workspaceIdForTurn()` and resolves through `canView` gate
4. Once restored, `?workspace=` lands in URL and flag is never sent again (panel the person closed stays closed)

**Binding is idempotent**: The WHERE clause matches only when column is NULL or holds a DIFFERENT id — steady state (every turn after first) updates no rows. A failed write is logged and swallowed (next reopen loses panel, but current turn is not aborted).

**Key Sources**:
- `/lib/nexus/workspace-conversation-binding.ts` — Three binding operations + `workspaceIdForTurn` for restore
- `/lib/nexus/workspace-restore-state.ts` — Per-tab restore state tracking
- `/actions/nexus/workspace-binding.actions.ts` — Server actions for client binding lookups
- `/app/api/nexus/chat/route.ts` — Binds after `setupConversation`, uses `workspaceIdForTurn` during restore
- `/app/(protected)/nexus/page.tsx` — `useRestoreBoundWorkspace` client hook

**Focused Tests**:
- `tests/unit/nexus-workspace-conversation-binding.test.ts` — User-scoped predicates, NULL-or-different write, last-activity ordering

#### Draft Auto-Send Handshake (#1791)

The Atrium "Ask the agent" card and Library "Build it for me" can auto-send a prefilled draft WITHOUT making `?send=1` a thing any external link can trigger.

**Security Model** (`lib/nexus/draft-auto-send.ts`):

1. **Same-tab handshake**: `armDraftAutoSend(draft)` writes a nonce → draft entry to sessionStorage immediately before `router.push`
2. **Exact match required**: `consumeDraftAutoSend(nonce, draft)` honors the flag ONLY when this tab's storage holds that nonce for that EXACT draft text
3. **External links degrade gracefully**: A link from outside the app has no entry and simply prefills (cannot trigger auto-send)
4. **One-shot**: Entry deleted on first read (or mismatch), so reload/Back re-prefills rather than sending again
5. **Truncation refuses auto-send**: Drafts capped at 4,000 characters (`MAX_DRAFT_CHARS`); truncated drafts are NOT auto-sent and show a warning

**URL Parameters**:
- `?workspace=<id>` — The artifact to bind
- `?id=<conversation>` — Continue bound conversation (from `findLatestConversationForWorkspace`)
- `?draft=<text>` — Prefilled prompt text
- `?send=<nonce>` — Auto-send nonce (must match sessionStorage)

**nexusWorkspaceHref Builder**: All in-app workspace links use `nexusWorkspaceHref()` from `lib/nexus/draft-auto-send.ts`:
- `autoSend: true` arms the handshake for immediate send (Ask card, "Build it for me")
- `autoSend: false` (or omitted) only prefills (rendered links someone could copy)

**Prompt Auto-Loader** (`app/(protected)/nexus/_components/prompt-auto-loader.tsx`):
- Consumes handshake BEFORE rewriting URL
- Sends on same 100ms tick as promptId path
- Skipped if effect was cleaned up (unmounted)

**Key Sources**:
- `/lib/nexus/draft-auto-send.ts` — Handshake functions, `nexusWorkspaceHref` builder
- `/app/(protected)/nexus/_components/prompt-auto-loader.tsx` — Consumer logic
- `/components/atrium/ArtifactAskAgentCard.tsx` — Ask card using `nexusWorkspaceHref`
- `/components/atrium/LibraryView.tsx` — "Build it for me" using auto-send

**Focused Tests**:
- `tests/unit/lib/nexus/draft-auto-send.test.ts` — Armed success, pasted-link refusal, swapped-prompt refusal, fire-at-most-once
- `tests/unit/nexus-prompt-auto-loader-autosend.test.tsx` — Loader behavior with router.replace re-render

#### Rename and Re-slug (#1791)

The workspace chat can rename content via `rename_workspace_content` tool. An unpublished rename allocates a fresh slug; an ever-published rename keeps the original slug (someone may have linked to it).

**Rename Tool** (`lib/nexus/workspace-chat-tools.ts`):
- Bound only when session user can edit the open object
- Uses `contentService.update` under the same `canView` → `canEdit` gate as Content settings dialog
- Trims title (update validates trimmed form but persists what it receives)
- Returns `objectId` for `useWorkspaceChangeSignal` refresh

**Re-slug Logic** (`lib/content/content-service.ts`):
- `updateInTransaction` handles renames inside a transaction with row lock
- `hasEverBeenPublishedInTx` checks: ever published → keep slug; never published → allocate new slug via `uniqueSlug`
- Publication row flips to `unpublished` on unpublish, preserving the "ever published" check
- Self-exclusion: `uniqueSlug(excludeId)` prevents counting the row's current slug as a collision

**Collision Handling**:
- SQLSTATE 23505 (unique violation) maps to `ConflictError` — concurrent slug race surfaces as 409 "please retry"
- Case-only rename or same-title rename does not churn the slug suffix

**Key Sources**:
- `/lib/nexus/workspace-chat-tools.ts` — `rename_workspace_content` tool
- `/lib/content/content-service.ts` — `updateInTransaction`, `hasEverBeenPublishedInTx`, `uniqueSlug`
- `/docs/features/nexus-conversation-architecture.md` — Workspace object binding system prompt addition

**Focused Tests**:
- `tests/unit/atrium-rename-reslug.test.ts` — Re-slug when unpublished, freeze when ever published, collision handling, self-exclusion
- `tests/unit/lib/nexus/workspace-chat-tools.test.ts` — Rename tool validation and authorization

#### Mode-Only Artifact Updates (#1791)

`update_workspace_artifact` can change only `dataAccess` without providing `code` — no version is created, no §28.3 screening runs.

**Contract**:
- `code` is optional WHEN `dataAccess` is supplied
- A call with `dataAccess` and no `code` is a mode-only change: flips sandbox data-bridge mode in place
- A call with NEITHER field is rejected with an explicit message
- The mode-only path skips screening — no model-authored bytes are persisted
- A failed mode-only flip returns an ERROR (not `ok: true` with warning)
- Authorization unchanged: `contentService.update` runs the same `canView` → `canEdit` gate

**Result**: Still carries `objectId` and no `error`, so `useWorkspaceChangeSignal` fires and panel refetches.

**Key Sources**:
- `/lib/nexus/workspace-chat-tools.ts` — Tool schema with optional `code`, executor validation
- `/lib/content/content-service.ts` — `applyDataAccessAfterVersion` with optional version number

**Focused Tests**:
- `tests/unit/lib/nexus/workspace-chat-tools.test.ts` — Mode-only success (no createVersion, no screen), neither-field rejection

#### Version Authorship Labels (#1791)

Versions written by Nexus chat show "via Nexus chat" in the dropdown and About rail — distinguishing model-authored code from human-edited code while keeping `author_actor: "human"` (correct, because the tools run under the user's requester).

**Label Source** (`lib/content/version-author-label.ts`):
- `NEXUS_CHAT_AUTHOR_LABEL = "nexus-chat"` — single constant
- `versionAuthorLabel()` → "AI" | "via Nexus chat" | "human"
- `versionAuthorDescription()` → "Agent-maintained..." | "Written by the agent in Nexus chat" | "Human-authored"

**Labeling Rules**:
- Autonomous agent version stays "AI" regardless of surface label — `authorActor: "agent"` is stronger
- Never "you" — `VersionSummary` omits `authorUserId`, so no surface can tell if the human author is the current viewer
- Unknown label falls back to "human" — never render raw text in UI

**Storage** (`content_versions.author_label`, migration 183):
- Free-text VARCHAR(64) — e.g., `"nexus-chat"`
- Carries the surface, not the authorization (that stays in `author_actor`/`author_user_id`)
- Mirrors pattern `applyAgentEdit` uses for comment threads

**Publish Snapshots**: Chat-published documents are labeled only when the chat EDITED them in the same request (`editedThisRequest` flag). A publish-only request (no edits) keeps the document's original provenance.

**Key Sources**:
- `/lib/content/version-author-label.ts` — Label functions
- `/lib/db/schema/tables/content-versions.ts` — `authorLabel` column
- `/lib/nexus/workspace-chat-tools.ts` — `NEXUS_CHAT_AUTHOR_LABEL` stamping
- `/lib/content/collab/snapshot-before-publish.ts` — Publish snapshot with optional label

**Focused Tests**:
- `tests/unit/atrium-version-author-label.test.ts` — All three labels, agent-wins rule, no-"you" rule
- `tests/unit/atrium-snapshot-before-publish-label.test.ts` — Label reaches versionService.snapshot
- `tests/unit/lib/nexus/workspace-chat-tools.test.ts` — Label on createVersion

#### Workspace Tool History Pruning (#1791)

The messages sent to the MODEL are pruned to remove superseded workspace source payloads — keeping the most recent version of code while preserving the call/result pairing required for replay.

**Problem**: Every `update_workspace_artifact` carries the full new source (20-60 KB). After 5-6 edits, the conversation history contains 100k+ tokens of code the model has already superseded — paid for on every turn, crowding real context.

**Pruning Rules** (`lib/nexus/workspace-tool-history.ts`):

| Part Type | Keep Condition |
|-----------|---------------|
| Newest REPLACE write | Kept verbatim (artifact `code` or document `mode: "replace"`) |
| APPEND writes after replace | Kept verbatim (adds to document, not replaces) |
| Mode-only updates | Kept verbatim (no source to prune) |
| Read pages after newest replace | Newest at EACH byteOffset kept (paged reads) |
| Reads before newest replace | Stubbed |
| Writes before newest replace | Stubbed |
| Appends before fresh offset-0 read | Stubbed (fresh read supersedes them) |
| Parts without `objectId` | Kept verbatim (legacy, cannot group) |

**Stub Format**:
```
[omitted from history: 25,000 characters of superseded input.code. This is an EARLIER revision, not the current one — call read_workspace_content to see what the workspace holds now.]
```

**Per-Object Tracking**: Parts are keyed by `objectId` — a conversation rebound to another artifact cannot stub the first artifact's source reads.

**Model-Side Only**: Applied to `safeModelMessages`, never to `safePersistenceMessages`. What's written to the database and what the thread renders on reload are byte-for-byte unchanged.

**Key Sources**:
- `/lib/nexus/workspace-tool-history.ts` — `pruneStaleWorkspaceToolPayloads()`, `indexSourceParts()`
- `/app/api/nexus/chat/route.ts` — Applied to `safeModelMessages` only
- `/docs/features/nexus-conversation-architecture.md` — Pruning paragraph

**Focused Tests**:
- `tests/unit/lib/nexus/workspace-tool-history.test.ts` — Paged reads, mode-only updates, document appends, rebound conversations

#### Preview Diagnostics (#1787)

When a Nexus chat writes an artifact, it watches the preview render but receives no direct feedback about whether the code worked. In the incident that prompted this feature, a model wrote a dashboard with a filter based on a non-existent column, then told the user the dropdown was "populated live from the database" — every query had failed silently, and the model had no way to know.

The preview now records its failures in a client-side ring buffer, and each chat request carries those entries to the server where they appear in `read_workspace_content` results as `previewDiagnostics`. The model can then see what failed on the NEXT turn and fix its own SQL.

**Buffer behavior** (`lib/atrium/artifact-preview-diagnostics.ts`):
- **Per-artifact**: The buffer tracks entries for ONE artifact at a time. Switching artifacts replaces the buffer outright so stale failures are never reported against the new code.
- **Bounded**: At most 10 entries are retained; oldest are dropped first. Message and SQL prefix are each bounded to prevent unbounded prompt injection.
- **Read once**: `takeArtifactPreviewDiagnostics()` reads and clears the buffer. Each failure reaches the model exactly once, never re-sent on later turns.
- **Restored on send failure**: If the request never reaches the server (network error, session check failure), the taken entries are restored so the preview may re-run the failing query.
- **Cleared on fresh version**: When a new artifact version mounts, `clearArtifactPreviewDiagnostics()` drops all previous entries so they don't describe code that is no longer running.

**Entry shape**:
- `kind`: `"data"` for bridge call failures, `"script"` for uncaught frame errors
- `code`: The typed bridge error code for `kind: "data"` (see below)
- `message`: Human-readable error (bounded, flattened to one line)
- `sql`: A prefix of the failing SQL (for `query_error`), capped at 200 characters so the model can identify which query broke
- `at`: Epoch milliseconds, so the model can tell stale from fresh

**Server validation**: The `contentId` in the buffer is checked against the object the server actually bound. A buffer left over from a different artifact (or a forged one) is dropped rather than shown.

**Key Sources**:
- `/lib/atrium/artifact-preview-diagnostics.ts` — Client-side ring buffer
- `/lib/nexus/workspace-chat-tools.ts` — `read_workspace_content` returns `previewDiagnostics`
- `/app/(protected)/nexus/page.tsx` — Attaches buffer to chat request body

**Focused Tests**:
- `tests/unit/atrium-artifact-preview-diagnostics.test.ts` — Buffer lifecycle, bounded entries, artifact isolation
- `tests/unit/lib/nexus/workspace-chat-tools.test.ts` — `previewDiagnostics` attached to read results
- `tests/e2e/atrium-sandbox-typed-errors.spec.ts` — End-to-end typed error forwarding

**Panel Refresh Without Reload**: When a mutating workspace tool result lands, the Nexus tool-call renderer fires `atrium:workspace-changed` (a DOM event). `WorkspacePanel` alone subscribes, refetches its loader (where pinned `dataAccess` comes from), then bumps `ArtifactCanvas.refreshSignal`. Two independent subscribers would race; one owner ensures consistent order.

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

### Create Form Validation (#1697)

**Location**: `/app/(protected)/utilities/assistant-architect/create/_components/create-form.tsx`

The assistant creation flow at `/utilities/assistant-architect/create` requires an icon (`imagePath`) before the user can continue to the prompts step. A blocked submit must produce **visible feedback** — toast + focus + inline message — rather than a silent no-op that looks like a dead button.

**Root causes fixed in #1697**:
1. **Toast system was not mounted** — The app uses sonner (`app/layout.tsx` mounts `<Toaster />`), but `use-toast.ts` was writing to an unmounted shadcn queue. `useToast()` is now a thin adapter over sonner so all ~60 call sites render correctly.
2. **Form validation errors were stale** — `form.formState.errors` reads empty immediately after `await form.trigger()` due to proxy timing. Validation errors now come from `handleSubmit(onValid, onInvalid)` callbacks.
3. **Focus had no target** — `form.setFocus("imagePath")` failed because `IconPicker` never forwarded `field.ref`. The icon grid now carries the ref with `role="radiogroup"` and proper ARIA.

**Invariants**:
- Toasts use `components/ui/use-toast.ts` adapter → sonner — never mount a second toast root
- `useFormField` subscribes via `useFormState({ name })`, not `useFormContext().formState` — descendants must re-render
- Validation errors come from `handleSubmit` callbacks, not `form.formState.errors` after `trigger()`
- Focus uses `shouldFocusError: false` with explicit `setFocus()` to control order (schema order matches display order)
- Icon grid has `role="radiogroup"` with `aria-required` and `aria-labelledby` — each option is `role="radio"` with `aria-checked`
- Buttons outside `<form>` require `onSubmit={e => e.preventDefault()}` to prevent implicit submission on Enter

**Key Sources**:
- `/app/(protected)/utilities/assistant-architect/create/_components/create-form.tsx` — Create form with validation
- `/components/ui/use-toast.ts` — Sonner adapter for toast system
- `/components/ui/form.tsx` — `useFormField` using `useFormState`

**Focused Tests**:
- `tests/unit/assistant-architect-create-form.test.tsx` — Blocked submit feedback, focus, ARIA
- `tests/unit/use-toast-sonner-adapter.test.ts` — Toast adapter reaches sonner
- `tests/e2e/assistant-architect-create-add-field.functional.spec.ts` — E2E blocked submit visibility

### Key Source Files

| File | Purpose |
|------|---------|
| `/lib/assistant-architect/` | Core assistant execution logic |
| `/app/(protected)/prompt-library/` | UI for managing assistants |
| `/app/(protected)/utilities/assistant-architect/create/` | Create flow UI |
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

Artifacts can interact with data through a sandbox bridge. The `data_access` mode on each **content version** determines which operation is allowed for that version's code (#1789).

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
| `/c/<slug>` intranet reader | **enabled** | Authenticated, `canView`-gated, pins PUBLISHED version's mode (#1789) |
| `/atrium/<id>/view` full-screen viewer | **enabled** | Readers get published version when Live; editors get requested or head (#1789) |
| `/atrium/<id>/edit` canvas preview | **enabled** | Where the artifact is authored; keys on version's mode stamp |
| Nexus workspace panel (`?workspace=`) | **enabled** | Same canvas behind same `canView`-gated loader |
| `ArtifactEmbedBlock` (artifact inside document) | fail closed | Renders inside somebody else's document, including anonymous reader |
| Library thumbnails | fail closed | Decorative grid tiles; nothing to interact with |
| `/p/<slug>` public reader | fail closed | Anonymous — no viewer to scope a query to |

**Publication was never the authorization** — `queryArtifactData`, `submitArtifactRecord`, and `listArtifactRecords` each independently resolve the session, run `contentService.get` (the shared 404 mask + `canView`), re-check `kind === "artifact"`, and re-check the `data_access` mode of the **VERSION being rendered** (#1789). None reads publication state. Enabling the bridge on authoring surfaces changes only *where* a request may originate, not *who* may run one — and removes the publish → test → republish loop where an author could not exercise a query-mode dashboard until it was in front of an audience.

**Dual-Layer Enforcement** (#1712, #1789): Each mode is enforced twice, and both layers must agree. The reader page pins the mode of the **VERSION it renders** (published for Live, head for drafts), and the sandbox refuses any operation that does not match that pinned mode. The Server Actions independently re-check that version's mode via `resolveRenderedVersionAccess`. A mode change (settings, REST `PATCH`, MCP) only takes effect on a fresh page load, which starts with no queried data in memory. This prevents the owner from loading a viewer with `query` mode, then flipping to `records` to let that page submit queried rows back into the records store—exactly the exfiltration loop the mutual exclusivity is meant to close.

#### Query Concurrency and Transport (#1788)

`query` operations now use a dedicated Route Handler for parallel execution, with sophisticated concurrency management and deadline-aware timeout budgeting.

**Why a Route Handler (not Server Action)**: The Next.js App Router dispatches Server Actions strictly one at a time. A six-query `Promise.all` dashboard executed them back-to-back (~6.5s for ~1.2s of actual work). `fetch` to a Route Handler has no such queue, so queries run genuinely in parallel.

**Transport Path**:
```
ArtifactSandbox parent (trusted contentId from props)
  | fetch POST /api/atrium/artifacts/{id}/query (sqlBase64)
  v
queryArtifactData Server Action (in-process, guards unchanged)
  | End-to-end 30s deadline: preflight + MCP handshake + execution
  v
PSD Data MCP connector
```

**Concurrency Model**:

| Lane | Concurrent Cap | Queue Depth | Total Outstanding |
|------|---------------|-------------|-------------------|
| Query (`AtriumData.query`) | **6** at once | 26 waiting | 32 (matches host cap) |
| Records (`submit`/`list`) | **1** at a time | 31 waiting | 32 (matches host cap) |

Query and record ops never mix on one mount (mode pinning), so there is only one active lane per artifact.

**Deadline Architecture**: ONE 30s budget armed at the TOP of `queryArtifactData` and spanning:

1. **Preflight** — session resolution, visibility check, version lookup, connector config read (each stage raced against deadline)
2. **MCP Handshake** — connector tools resolution with deadline-aware timeout
3. **Execution** — the `query_data` tool call with remaining budget

The sandbox host's 45s clock covers the entire server turn, including network latency. A preflight-stage timeout stops before starting the NEXT stage (`stopIfExpired()` checks), preventing background work pileups from retries.

**Dispatch Acknowledgment**: When a queued request starts, the parent posts `atrium-artifact-data-ack` to the frame. The host runs a queue-tolerant 315s pre-ack budget, then re-arms the real 45s server budget on the ack. This ensures the frame's timeout clock starts when work BEGINS, not when the page POSTED.

**SQL Base64 Encoding**: The request body carries `sqlBase64` (UTF-8 base64) rather than raw SQL because the edge WAF's `SQLi_BODY` managed rule blocks request bodies that match SQL patterns with a bare 403 the app never sees. This is transport encoding only — the decoded SQL is validated and executed by the same code path as before, under the viewer's row-level permissions.

**Key Sources**:
- `/app/api/atrium/artifacts/[id]/query/route.ts` — Route handler with base64 decoding
- `/lib/content/artifact-query-transport.ts` — Wire contract, route path builder, status codes
- `/actions/db/atrium/artifact-query.ts` — `queryArtifactData` with end-to-end deadline, `withDeadline` helper
- `/components/atrium/ArtifactSandbox.tsx` — `fetchArtifactQuery`, queue pump, dispatch ack

**Focused Tests**:
- `tests/unit/atrium-artifact-query-route.test.ts` — Route handler validation
- `tests/unit/atrium-artifact-query-action.test.ts` — Server-side error classification and timeout
- `tests/unit/atrium-artifact-record-transport-failure.test.tsx` — Queue expiry, dispatch abandonment

**Pinning Mechanism** (#1712, #1789):
- Reader page (`app/(protected)/c/[slug]/page.tsx`) pins the **published version's** `data_access` via `resolveVersionDataAccess(version, obj.dataAccess)`
- Full-screen viewer (`app/(protected)/atrium/[id]/view/page.tsx`) uses `resolveViewVersion()` — readers get published version, editors get requested or head
- Workspace panel action (`loadWorkspacePanelAction`) returns `dataAccess` for artifacts, so the pin is server-resolved like every other bridge input
- `ArtifactSandbox` stores the mode in a ref for the mount's lifetime—re-renders cannot widen what an already-running artifact may do
- `isOpAllowedByLoadedMode()` rejects ops before the Server Action is called
- `normalizeDataAccess()` in `/lib/content/types.ts` collapses unrecognized values to `"none"` (fail closed)
- Canvas sandbox keys on `contentId:dataAccess:versionId` — flipping the mode in Content settings remounts the frame (the "fresh load" the pin requires), and an artifact change also remounts
- **Preview Frame Preservation** (#1788): The canvas keeps the preview iframe mounted on the Code tab (hidden with `display: none`), preventing query re-runs on tab toggle. A frame is kept hidden, never first created hidden — an element inside `display: none` has no layout box, so charting libraries that size from `clientWidth` would initialize at zero. The canvas latches the exact composite key (`previewMountKey`) and drops the frame if any part changes while hidden, remounting visible on return to Preview.

**Viewer-Scoped PSD Queries** (`query` mode):
- Artifact calls `window.AtriumData.query(sql, { limit, offset })`
- Query executes **as the viewer** with their row-level security
- Author cannot influence which rows the viewer sees
- Uses the same PSD Data MCP connector as Nexus chat (resolved via `/lib/nexus/model-router/psd-data-connector.ts`)
- **Numeric limits** (defined in `/lib/content/artifact-query-limits.ts` and interpolated into authoring guidance #1792):
  - **Default limit**: 200 (applied when omitted, NOT an error — unaggregated SELECTs return first 200 rows silently)
  - **Max limit**: 2,000 (clamped, not rejected)
  - **Max offset**: 1,000,000 (larger values clamp to last reachable page)
  - **Max SQL length**: 8,000 characters
  - **Server timeout**: 30s from dispatch (queue wait excluded)
  - **Client timeout**: 45s safety clock
  - **Rate limit**: 60 queries per viewer per artifact per minute
- **Concurrency**: Up to 6 queries run in parallel via fetch Route Handler; excess queue rather than reject (#1788)
- **Budget guidance**: Aim for 3-8 aggregate queries per load, fired together (`Promise.all`)

**Artifact API** (installed by sandbox host):
```typescript
interface AtriumData {
  submit(namespace: string, payload: Record<string, unknown>): Promise<{ id: string; createdAt: string }>;
  list(namespace: string, options?: { limit?: number; scope?: "all" | "mine" }): Promise<{ records: Array<{...}> }>;
  query(sql: string, options?: { limit?: number; offset?: number }): Promise<{ columns: string[]; rows: unknown[][]; ... }>;
}
```

**Source**: `/docs/features/atrium-artifact-data.md` — comprehensive data bridge documentation.

#### Typed Bridge Errors (#1787)

Every `AtriumData` operation can fail. The bridge classifies failures into a closed set of typed error codes so artifact authors can handle them appropriately instead of rendering a generic "something went wrong" or misclassifying a broken SQL query as a permission error.

**Error Codes** (defined in `lib/content/artifact-bridge-errors.ts`):

| Code | When | What to Show |
|------|------|--------------|
| `unauthenticated` | No session or unusable ID token | Sign-in prompt |
| `forbidden` | Signed in but not allowed to view/use artifact | No-access state (not error details) |
| `not_query_mode` | Called `query` on artifact not in `query` mode | Fix artifact mode, not the code |
| `rate_limited` | Per-viewer, per-artifact budget exhausted | Retry message with `err.retryAfterSeconds` |
| `timeout` | Request did not answer within bridge budget | Retry message |
| `query_error` | **SQL was rejected** (bad syntax, unknown column, bad arguments) | Show `err.message` to author — fix the SQL, do NOT show no-access state |
| `too_many_requests` | Too many bridge calls already in flight from this page | Retry message |
| `unavailable` | Anything else: connector unconfigured, upstream down, unexpected shape | Generic unavailable message |

**Security model**:
- The error describes the VIEWER'S own request evaluated against their own permissions
- The sandbox frame has no egress (`connect-src 'none'`, opaque origin) — data cannot be exfiltrated through error messages
- `query_error` carries the upstream database message ONLY when the requester can EDIT the artifact (editors could run the same SQL from the Code tab anyway)
- Plain readers get `query_error` with a generic message — no schema leakage

**Required error handling pattern**:
```typescript
try {
  const result = await AtriumData.query(sql);
  // use result
} catch (err) {
  switch (err.code) {
    case "forbidden":
    case "unauthenticated":
      // Show sign-in or no-access state — the VIEWER lacks permission
      break;
    case "query_error":
      // The SQL is wrong — show err.message (the database error)
      // DO NOT show a no-access state; the fix is in the SQL, not permissions
      break;
    case "rate_limited":
      // Show retry message with err.retryAfterSeconds
      break;
    // ... handle other codes
  }
}
```

**Never assume a call succeeded**. A dashboard whose every query fails looks exactly like one that works — empty charts, silent errors. Wrap every bridge call in try/catch and render an appropriate state for each failure mode.

**Error message bounds**:
- Messages capped at 500 characters before crossing trust boundaries
- Multi-line Postgres errors flattened to one line (newlines replaced with spaces)
- SQL prefix in preview diagnostics capped at 200 characters (enough to identify the query)

**Key Sources**:
- `/lib/content/artifact-bridge-errors.ts` — Typed error codes and default messages
- `/actions/db/atrium/artifact-query.ts` — Server-side classification of failures
- `/components/atrium/ArtifactSandbox.tsx` — Carries errors across postMessage bridge
- `/infra/sandbox-host/render.html` — Frame-side error rejection with `.code` property

**Focused Tests**:
- `tests/unit/atrium-artifact-query-action.test.ts` — Server-side error classification
- `tests/unit/atrium-artifact-data-bridge.test.tsx` — Bridge error handling
- `tests/e2e/atrium-sandbox-typed-errors.spec.ts` — End-to-end error forwarding in real browser

#### Version-Scoped Data-Access Mode (#1789)

Before migration 184, `data_access` lived only on `content_objects`. This caused a critical bug: when an object was Live, the author's draft-mode changes would silently re-capability the Live page. A records-mode sign-up sheet whose author flipped to `query` while building the next version would break `AtriumData.submit` for every reader, immediately, with no republish. The reverse — taking a Live dashboard's data offline — was equally possible.

**Migration 184** stamps the mode on each `content_versions` row:
- `content_versions.data_access` — the mode THIS version's code was authored for (nullable)
- `content_objects.data_access` — the mode of the working HEAD (stamped onto new versions)

Every render surface now pins the mode of the version it renders, not the object's current mode.

**Resolution Contract** (`resolveVersionDataAccess` in `/lib/content/types.ts`):
```typescript
// The canonical ONE-FUNCTION for mode resolution — used by every surface
resolveVersionDataAccess(version, object.dataAccess)
  => version?.dataAccess ?? normalizeDataAccess(object.dataAccess)
```

A version predating migration 184 carries no stamp (`null`) and falls back to the object's mode — exactly the pre-migration behavior. Documents never carry a stamp (no sandbox).

**Live Page Behavior** (`/app/(protected)/c/[slug]/page.tsx`):
- Pins the PUBLISHED version's mode — independent of author's draft changes
- Full-screen link includes `?version=` pointing to the published version
- A mode change on a Live HEAD forks a new version (`propagateDataAccessToHead`) instead of re-capabilitying Live
- The author's preview picks up the new mode; readers keep the mode their version was published with

**View Page Behavior** (`/app/(protected)/atrium/[id]/view/page.tsx`):
- **Readers** (cannot edit) receive the LIVE published version when Live — same as `/c/`
- **Editors** receive `?version=` when provided (and belongs to this object), else head
- A `version` from another object is ignored (scoped lookup finds nothing)
- The server never trusts a reader-submitted versionId — readers get the published version to prevent mode-selection attacks

**Mode Change on Live Head** (`propagateDataAccessToHead` in `/lib/content/content-service.ts`):
- If head is NOT Live — stamp in place (author preview picks up change)
- If head IS Live — write a NEW version (same code, new mode) so object becomes draft-ahead-of-Live
- Author must republish to change Live capability

**Bridge Action Authorization** (`resolveRenderedVersionAccess` in `/actions/db/atrium/artifact-guards.ts`):
- Determines which version is running and the mode that version was authored for
- Readers: server picks published version (ignoring any submitted versionId)
- Editors: honor requested version if it belongs to this object
- Validates version belongs to the artifact on every bridge call
- A lookup failure falls back to head under object's mode (pre-1789 contract, logged)

**Canvas Version Picker** (`components/atrium/ArtifactCanvas.tsx`):
- `useCanvasBridgePin` uses `loadedDataAccess` (version's stamp) when loaded, else props pin
- `useReloadOnObjectModeChange` reloads head when object mode prop changes
- Sandbox keys on `contentId:dataAccess:versionId` — previewing an older version remounts with that version's mode
- Mode-only update (`update_workspace_artifact` without code) reloads without version change

**Rollback** (`versionService.rollbackToVersion`):
- Restoring a version restores its stamped mode to the object
- Head stamp equals object mode invariant preserved
- A null stamp (pre-184 or document) leaves the object's mode unchanged

**Key Sources**:
- `/infra/database/schema/184-atrium-version-data-access.sql` — Migration with comprehensive header comment
- `/lib/db/schema/tables/content-versions.ts` — `dataAccess` column with documentation
- `/lib/content/types.ts` — `resolveVersionDataAccess()`, `ContentVersionDTO.dataAccess`
- `/lib/content/version-service.ts` — `snapshotInTx` stamps mode, `rollbackToVersion` restores it
- `/lib/content/content-service.ts` — `propagateDataAccessToHead()` forks on Live head
- `/actions/db/atrium/artifact-guards.ts` — `resolveRenderedVersionAccess()` for bridge actions
- `/app/(protected)/c/[slug]/page.tsx` — Reader page pins published version's mode
- `/app/(protected)/atrium/[id]/view/page.tsx` — `resolveViewVersion()` for viewer versioning
- `/components/atrium/ArtifactCanvas.tsx` — `useCanvasBridgePin`, `useReloadOnObjectModeChange`
- `/actions/db/atrium/get-artifact-code.ts` — Returns version's resolved mode for canvas

**Focused Tests**:
- `tests/e2e/atrium-live-draft-data-access.functional.spec.ts` — Live page pins published version's mode
- `tests/unit/atrium-rendered-version-data-access.test.ts` — Reader vs editor version resolution
- `tests/unit/atrium-version-data-access-migration.test.ts` — Backfill behavior, NULL fallback
- `tests/unit/atrium-version-data-access-stamp.test.ts` — Stamp on snapshot, mode preservation
- `tests/unit/atrium-content-data-access-update-guard.test.ts` — Mode change on Live vs non-Live head
- `tests/unit/atrium-rollback.test.ts` — Rollback restores version's mode

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

### Shared Data Contract (#1749, #1792)

The `AtriumData` bridge contract is defined in `/lib/content/atrium-data-contract.ts` and shared across all artifact-authoring surfaces:

- **`DATA_ACCESS_DESC`** — What the three modes mean (imported by both MCP content tools and workspace chat tools)
- **`ATRIUM_DATA_AUTHORING_GUIDANCE`** — How to write artifact code against the bridge (the operations, return shapes, authoring rules, typed error handling, numeric limits, and script timing guarantees: document-order execution, external script await, synthetic `DOMContentLoaded`/`load`)

**Both surfaces carry the full guidance as of #1792**: The MCP content tools (`create_artifact`, `create_version`) and the Nexus workspace chat tools both import and append `ATRIUM_DATA_AUTHORING_GUIDANCE`. Before #1792, only the workspace chat carried it — a model using MCP tools knew `query` mode existed but not that `rows` are tuples in `columns` order, leading to `rows.map(r => r.school_name)` returning blanks.

**Numeric limits are interpolated from a single source**: The guidance imports constants from `/lib/content/artifact-query-limits.ts` — the same module the query action (`artifact-query.ts`) and sandbox bridge (`ArtifactSandbox.tsx`) enforce them from. This ensures models cannot be told a limit the code does not apply:

| Constant | Value | Guidance Text |
|----------|-------|---------------|
| `ARTIFACT_QUERY_DEFAULT_LIMIT` | 200 | "`limit` DEFAULTS TO 200 when you omit it" |
| `ARTIFACT_QUERY_MAX_LIMIT` | 2,000 | "capped at 2000" |
| `ARTIFACT_QUERY_MAX_OFFSET` | 1,000,000 | "offset is capped at 1,000,000" |
| `ARTIFACT_QUERY_MAX_SQL_LENGTH` | 8,000 | "SQL is capped at 8000 characters" |
| `ARTIFACT_QUERY_SERVER_TIMEOUT_MS` | 30,000 | "30s on the server" |
| `ARTIFACT_MAX_CONCURRENT_DATA_REQUESTS` | 6 | "up to 6 at a time" |
| `ARTIFACT_MAX_PENDING_DATA_REQUESTS` | 32 | "past 32 outstanding... reject with `too_many_requests`" |

**Why the default limit is stated explicitly** (#1792): An unaggregated SELECT with no `limit` returns the first 200 rows silently — no error, no warning, just a wrong total. Models must be told to aggregate in SQL and compare `returnedCount` to `totalCount` before rendering totals.

The guidance also includes explicit instructions to **wrap every call in try/catch** and branch on `err.code`. Models are told to render a no-access state ONLY for `forbidden` and `unauthenticated`, and to show `err.message` for `query_error` instead of dressing a broken query up as a permissions problem.

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
