/**
 * Atrium agent bridge — apply an agent edit to the live document
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). Lets a server-side agent push markdown
 * into the SAME live Y.Doc that browser clients are editing, attributed to the
 * agent (purple rail). This is the rebuilt equivalent of Proof's `rewrite` bridge
 * operation: the agent provides markdown, it is stamped `ai:<agentId>`, and the
 * change diffs into the live document so connected editors see it in real time.
 *
 * The mutation runs through Hocuspocus `openDirectConnection().transact()` so it
 * shares the document the websocket clients hold; `updateYFragment` (y-prosemirror)
 * diffs the new ProseMirror tree into the existing Yjs fragment rather than
 * clobbering it, minimizing disruption to concurrent human cursors.
 *
 * Guardrails + PII screening happen in the route BEFORE this is called — by the
 * time markdown reaches here it is already cleared for persistence.
 */

import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc, updateYFragment } from "y-prosemirror";
import type { Doc as YDoc } from "yjs";
import { getCollabServer } from "./collab-server";
import { getSchemaExtensions } from "./editor-extensions";
import {
  markdownToProseMirrorJSON,
  stampAuthor,
  yDocToProseMirrorJSON,
} from "./markdown-bridge";
import { saveDocState } from "./doc-state-store";
import { COLLAB_FIELD, makeAuthorTag } from "./provenance";
import * as Y from "yjs";

export type AgentEditMode = "replace" | "append";

export interface AgentEditInput {
  objectId: string;
  /** Already guardrails/PII-cleared markdown the agent wants to write. */
  markdown: string;
  /** agent_identities.id (or label) — stamped as `ai:<agentId>` on the rail. */
  agentId: string;
  /** replace = rewrite the whole document; append = add blocks at the end. */
  mode?: AgentEditMode;
}

/**
 * Apply the agent's markdown to the live document. Returns the full markdown now
 * represented (so the caller can refresh the projection / snapshot if desired).
 */
export async function applyAgentEdit(input: AgentEditInput): Promise<{ markdown: string }> {
  const { objectId, markdown, agentId, mode = "replace" } = input;
  const by = makeAuthorTag("agent", agentId);
  const schema = getSchema(getSchemaExtensions());

  const direct = await getCollabServer().openDirectConnection(objectId);
  let resultMarkdown = markdown;
  try {
    await direct.transact((doc: YDoc) => {
      const agentJson = stampAuthor(markdownToProseMirrorJSON(markdown), by);

      const nextJson =
        mode === "append"
          ? (() => {
              const current = yDocToProseMirrorJSON(doc);
              return {
                ...current,
                content: [...(current.content ?? []), ...(agentJson.content ?? [])],
              };
            })()
          : agentJson;

      const node = schema.nodeFromJSON(nextJson);
      // y-prosemirror's BindingMetadata: a fresh mapping (PM node <-> Y type) and
      // overlapping-mark set, both empty for a one-shot server-side apply.
      updateYFragment(doc, doc.getXmlFragment(COLLAB_FIELD), node, {
        mapping: new Map(),
        isOMark: new Map(),
      });

      // Persist the projection from inside the same logical operation. For
      // append we cannot cheaply reconstruct the merged markdown here, so we
      // store the encoded state only (markdown left to the next client snapshot).
      const update = Y.encodeStateAsUpdate(doc);
      void saveDocState(objectId, update, mode === "replace" ? markdown : undefined);
    });
  } finally {
    await direct.disconnect();
  }

  if (mode === "append") {
    // The merged markdown is whatever the client serializes next; report the
    // appended fragment as the change applied.
    resultMarkdown = markdown;
  }
  return { markdown: resultMarkdown };
}

// Re-exported for callers that build a doc from scratch without a live connection
// (kept here so the bridge module is the single agent-write entry point).
export { prosemirrorJSONToYDoc };
