# Nexus workspace chat editing (Atrium §1087)

When an Atrium document or artifact is open beside the Nexus chat
(`/nexus?workspace=<id|slug>`, the panel from Epic #1059 §17), the chat can
**read and edit that open object** — the "re-prompt via adjacent chat" loop the
design spec foregrounds (§1065/§1087). "Add a section about X", "rewrite this
more formally", "change the button color" act on the panel, not just the chat.

Before this, the panel was a pure layout sibling with no content tools in the
chat surface, so asking the chat to change the open item did nothing.

## How it works

1. **Client** (`app/(protected)/nexus/page.tsx`): the open object's id/slug
   (`?workspace=`) is sent on each chat request as `workspaceId`, via a ref so
   opening/closing/switching the panel mid-conversation always sends the current
   value. Switching the model preserves `?workspace=` (the model-change reset
   used to drop it and silently close the panel).
2. **Server** (`app/api/nexus/chat/route.ts` → `lib/nexus/workspace-chat-tools.ts`):
   when `workspaceId` is present, the route binds a small set of AI SDK tools for
   THAT object and injects a system-prompt line telling the model an object is
   open. Tools are built **server-side** from the resolved id (never from the
   client tool list), and the object is resolved through `contentService`
   (canView 404-mask → canEdit 403) against the session user. `maxSteps` is
   raised so the model can read → edit → respond in one turn.

## Bound tools

| Tool | When | Effect |
|------|------|--------|
| `read_workspace_content` | always (viewable object) | Returns the current title/kind/body so the model edits from the current content. |
| `edit_workspace_document` | editable **document** | §28.3-screens the markdown, then writes it into the live Yjs doc via the agent bridge (`applyAgentEdit`) — it appears **immediately** in the panel with agent (purple-rail) attribution. `mode: append` (default) or `replace`. |
| `update_workspace_artifact` | editable **artifact** | Creates a new version via `contentService.createVersion` (which canView/canEdit-gates and §28.3-screens the body); the new version appears in the artifact's version dropdown. |

A caller who can view but not edit gets only `read_workspace_content`. An
unknown/unviewable `?workspace=` yields **no** tools — a bad param never breaks
chat.

### Safety & correctness invariants (PR #1136 review)

- **Both edit paths are §28.3-screened.** The document path screens the markdown
  before the bridge write. The artifact path screens the code **explicitly**
  before `createVersion` — because the tool runs under a `kind:"user"` (human)
  requester and `createVersion`'s internal screening only covers *agent*
  requesters, so relying on it would persist model code unscreened.
- **`read_workspace_content` never claims empty.** Documents read the
  `atrium_doc_state.markdown` projection (the live text is in Yjs, not
  `version.bodyInline`); when the current content can't be loaded (empty
  projection, or a large artifact whose source lives at `bodyLocation`) it
  returns `bodyUnavailable: true` so the model appends/edits conservatively
  instead of rewriting from nothing.
- **A bound skill's `allowed-tools` pin applies to workspace tools too** — a
  restrictive skill can't be widened just by opening a workspace.
- **Provider-native tools survive.** When workspace (or connector) tools are
  merged, the streaming service now merges the model's provider-native tools
  (web search / code interpreter) *under* them, instead of dropping them.
- The open object's **title is `JSON.stringify`-escaped** before it enters the
  system prompt (a title is user-controlled; raw newlines/quotes could inject
  prompt structure).

## Reuse (no new content logic)

Every tool calls the SAME §11–§15 services the Atrium editors and the MCP content
tools use — the agent bridge for live document edits, `contentService` for
artifact versions — so screening, provenance, visibility, and version allocation
are inherited, not reimplemented.

## Verified

- Unit: `tests/unit/lib/nexus/workspace-chat-tools.test.ts` (gating, read-only
  vs editable, kind-specific tool, screening-refusal).
- E2E: `tests/e2e/nexus-workspace-chat-tools.spec.ts` (the chat request carries
  `workspaceId`, preserved across a model change).
- Manually proven end-to-end on the :3100 collab server: a chat message drove
  `read_workspace_content` → `edit_workspace_document` and the text appeared live
  in the open editor with the purple agent rail; an artifact chat edit created a
  new version.

## Files

- `lib/nexus/workspace-chat-tools.ts` — the tool set + system-prompt fragment
- `app/api/nexus/chat/route.ts` — `workspaceId` schema field + `bindWorkspaceTools` + tool merge
- `app/(protected)/nexus/page.tsx` — client `workspaceId` plumbing + model-change param preservation
- `lib/content/collab/apply-agent-edit.ts` — the live document bridge (reused)
- `lib/content/content-service.ts` — `createVersion` (reused, screens internally)
