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
| `read_workspace_content` | always (viewable object) | Returns the current title/kind/body so the model edits from the current content. For an **artifact** it also returns `dataAccess` (the sandbox data-bridge mode) and, for a body over the 4 KiB inline threshold, loads the S3-backed source (capped at 512 KiB with `truncated: true`). |
| `edit_workspace_document` | editable **document** | §28.3-screens the markdown, then writes it into the live Yjs doc via the agent bridge (`applyAgentEdit`) — it appears **immediately** in the panel with agent (purple-rail) attribution. `mode: append` (default) or `replace`. |
| `update_workspace_artifact` | editable **artifact** | Creates a new version via `contentService.createVersion` (which canView/canEdit-gates and §28.3-screens the body); the new version appears in the artifact's version dropdown. Optional `dataAccess` (`records` \| `query` \| `none`) also sets the sandbox data-bridge mode, applied through `contentService.update` **before** the version. |

A caller who can view but not edit gets only `read_workspace_content`. An
unknown/unviewable `?workspace=` yields **no** tools — a bad param never breaks
chat.

### Live-data artifacts (#1749)

An artifact runs in a sandbox that installs `window.AtriumData`; which of its
three operations the code may call is pinned by the object's `dataAccess` mode
(`records` — `submit`/`list`; `query` — read-only PSD data queries run **as the
viewer**; `none`). The chat needs three things to build a live dashboard, and
before #1749 it had none of them:

1. **The contract.** `lib/content/atrium-data-contract.ts` holds the ONE copy of
   `DATA_ACCESS_DESC` (what the modes mean) and `ATRIUM_DATA_AUTHORING_GUIDANCE`
   (the operations, the `query()` return shape — rows are tuples in `columns`
   order — and the authoring rules). `DATA_ACCESS_DESC` is imported by both the
   MCP content tools and these workspace tools, so those two surfaces cannot
   drift apart; `ATRIUM_DATA_AUTHORING_GUIDANCE` has one consumer today (this
   surface). A unit test fails if either file redefines the strings locally. The
   `psd-atrium` agent skill keeps a hand-maintained Markdown copy of the same
   contract — it does not read these constants, so a contract change has to
   update both.
2. **Visibility of the mode.** `read_workspace_content` returns `dataAccess` for
   artifacts, matching what the MCP `get_content` handler already returns.
3. **The ability to change it.** `update_workspace_artifact` takes an optional
   `dataAccess` and applies it through `contentService.update` — the same
   canView/canEdit gate the Content settings dialog uses, under the session
   user's requester, so this is no new privilege. An invalid mode changes nothing
   at all (it is rejected before the screen even runs).

   **Write order: version first, mode second.** The two writes are not in one
   transaction, so one can land alone — and the two partial states are not
   equally bad. Saving the code first means a failed mode flip leaves the new
   code under the mode the artifact *already had*: its data capability never
   widens past what it was already granted, and the tool result says so with a
   `warning` instead of reporting an effective mode it did not set. The reverse
   order left the OLD code — authored and screened for the OLD mode — running
   under a WIDER new mode (e.g. `records` → `query`) while the error message
   claimed nothing had changed. A `createVersion` failure now writes nothing at
   all: the mode flip has not run yet.

**The panel refreshes without a reload.** When a mutating workspace tool result
lands, the Nexus tool-call renderer dispatches the `atrium:workspace-changed`
window event (`lib/atrium/workspace-change-event.ts`). A DOM event keeps the
panel decoupled from the conversation runtime it must never touch. The signal
fires once per tool call and never for a call replayed from history or an error
result, and it is scoped by the `objectId` every mutating tool result carries.

**One refresh owner.** `WorkspacePanel` alone subscribes. It re-runs its loader —
which is where the pinned `dataAccess` comes from — and only then bumps
`ArtifactCanvas`'s `refreshSignal` prop, which reloads the version list and head.
Two independent subscribers meant two independently-timed, independently-fallible
fetches: whichever landed first rendered a mixed state, and a panel fetch that
failed while the canvas fetch succeeded pinned the new code to the OLD mode for
the rest of the session. A refresh also re-checks the id it started for, so a
slow one cannot land on a panel the user has since switched to another object.

**Step budget.** A build turn explores the data before it writes code, so
`lib/nexus/chat-step-budget.ts` raises `maxSteps` to 20 when workspace tools are
bound; every other multi-step path keeps 10.

### Safety & correctness invariants (PR #1136 review)

- **Both edit paths are §28.3-screened.** The document path screens the markdown
  before the bridge write. The artifact path screens the code **explicitly**
  before `createVersion` — because the tool runs under a `kind:"user"` (human)
  requester and `createVersion`'s internal screening only covers *agent*
  requesters, so relying on it would persist model code unscreened.
- **`read_workspace_content` never claims empty.** Documents read the live Yjs
  doc, falling back to the `atrium_doc_state.markdown` projection then the
  version snapshot. Artifacts read `bodyInline`, or load the S3-backed source
  when the body is over the inline threshold. `bodyUnavailable: true` now means
  only that the load FAILED — never "the item is empty", which would let a
  rewrite clobber it.
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
  vs editable, kind-specific tool, screening-refusal, `dataAccess` read/set +
  ordering, S3 body load + truncation, shared-contract presence).
- Unit: `tests/unit/lib/content/atrium-data-contract.test.ts` (one source of
  truth), `tests/unit/lib/nexus/chat-step-budget.test.ts` (the widened bound),
  `tests/unit/nexus-workspace-change-signal.test.tsx` and
  `tests/unit/atrium-workspace-change-refresh.test.tsx` (the refresh signal).
- E2E: `tests/e2e/nexus-workspace-chat-tools.spec.ts` (the chat request carries
  `workspaceId`, preserved across a model change) and
  `tests/e2e/nexus-workspace-artifact-refresh.spec.ts` (the open artifact
  refetches on the signal with no reload).
- Manually proven end-to-end on the :3100 collab server: a chat message drove
  `read_workspace_content` → `edit_workspace_document` and the text appeared live
  in the open editor with the purple agent rail; an artifact chat edit created a
  new version.

## Files

- `lib/nexus/workspace-chat-tools.ts` — the tool set + system-prompt fragment
- `lib/content/atrium-data-contract.ts` — the shared `AtriumData` contract strings
- `lib/nexus/chat-step-budget.ts` — the multi-step bound
- `lib/atrium/workspace-change-event.ts` — the panel-refresh signal
- `app/api/nexus/chat/route.ts` — `workspaceId` schema field + `bindWorkspaceTools` + tool merge
- `app/(protected)/nexus/page.tsx` — client `workspaceId` plumbing + model-change param preservation
- `lib/content/collab/apply-agent-edit.ts` — the live document bridge (reused)
- `lib/content/content-service.ts` — `createVersion` (reused, screens internally)
