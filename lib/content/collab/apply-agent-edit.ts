/**
 * Atrium agent bridge — apply an agent edit to the live document
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). Lets a server-side agent push markdown
 * into the live collaborative document, attributed to the agent (purple rail). The
 * rebuilt equivalent of Proof's `rewrite` bridge operation.
 *
 * It applies the edit as a y-sync CLIENT of the collab server (a raw `ws` socket
 * speaking the y-protocols sync handshake — NOT y-websocket's WebsocketProvider,
 * which does not sync inside the Next.js server runtime). This is deliberate: the
 * agent-bridge route runs in the Next module graph while the websocket server runs
 * in the server.ts / voice-server.js graph — separate module instances with
 * separate in-memory doc registries (and separate bundles in prod). Connecting as a
 * client guarantees the edit lands on the SAME doc the editors are connected to, so
 * it broadcasts to them live (and persists + fans out via Redis). Works identically
 * in dev (no Redis) and prod.
 *
 * Guardrails + PII screening happen in the route BEFORE this is called.
 */

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { updateYFragment } from "y-prosemirror";
import { getCollabSchema } from "./editor-extensions";
import {
  markdownToProseMirrorJSON,
  stampAuthor,
  yDocToProseMirrorJSON,
} from "./markdown-bridge";
import { COLLAB_FIELD, makeAuthorTag } from "./provenance";
import { signCollabToken } from "./collab-token";
import { createLogger } from "@/lib/logger";

const log = createLogger({ context: "agent-bridge-client" });

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

const COLLAB_WS_PATH = "/api/atrium-collab";
const MESSAGE_SYNC = 0;
const SYNC_STEP_2 = 1; // y-protocols/sync messageYjsSyncStep2
const SYNC_TIMEOUT_MS = 10_000;

/** Apply the agent's markdown to the live document via a short-lived y-sync client. */
export async function applyAgentEdit(input: AgentEditInput): Promise<void> {
  const { objectId, markdown, agentId, mode = "replace" } = input;
  const by = makeAuthorTag("agent", agentId);
  const token = await signCollabToken({ sub: `agent:${agentId}`, oid: objectId, w: true });

  // COLLAB_INTERNAL_URL allows overriding the loopback target in ECS task definitions
  // where PORT may differ from the value server.ts actually binds on.
  const base = process.env.COLLAB_INTERNAL_URL ?? `ws://127.0.0.1:${process.env.PORT ?? "3000"}`;
  const url = `${base}${COLLAB_WS_PATH}/${objectId}?token=${encodeURIComponent(token)}`;
  const ydoc = new Y.Doc();
  // Use the runtime's native WebSocket (Node 22 / Bun) — the `ws` package has
  // import-interop issues inside the Next.js server runtime ("Unexpected server
  // response: 101"); the native client connects to our ws server like a browser.
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  // Track the ydoc update listener so it can be removed in the finally block,
  // preventing a stale listener from sending on a closing/closed socket.
  let registeredOnUpdate: ((update: Uint8Array) => void) | null = null;

  const applyEdit = (): void => {
    const schema = getCollabSchema();
    const agentJson = stampAuthor(markdownToProseMirrorJSON(markdown), by);
    const nextJson =
      mode === "append"
        ? (() => {
            const current = yDocToProseMirrorJSON(ydoc);
            return {
              ...current,
              content: [...(current.content ?? []), ...(agentJson.content ?? [])],
            };
          })()
        : agentJson;
    const node = schema.nodeFromJSON(nextJson);

    // Send the resulting Yjs update to the server, which applies + broadcasts it.
    const onUpdate = (update: Uint8Array): void => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      ws.send(encoding.toUint8Array(enc));
    };
    registeredOnUpdate = onUpdate;
    ydoc.on("update", onUpdate);
    ydoc.transact(() => {
      updateYFragment(ydoc, ydoc.getXmlFragment(COLLAB_FIELD), node, {
        mapping: new Map(),
        isOMark: new Map(),
      });
    }, "agent-bridge");
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let applied = false;
      const timer = setTimeout(() => {
        reject(new Error("collab sync timeout"));
      }, SYNC_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        // Ask the server for its current state.
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(enc, ydoc);
        ws.send(encoding.toUint8Array(enc));
      });

      ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          const u8 = new Uint8Array(ev.data as ArrayBuffer);
          const decoder = decoding.createDecoder(u8);
          if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MESSAGE_SYNC);
          const syncType = syncProtocol.readSyncMessage(decoder, enc, ydoc, ws);
          if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
          // Once the server's SyncStep2 has hydrated our doc, apply the edit once,
          // then allow time for the update to flush before resolving.
          if (!applied && syncType === SYNC_STEP_2) {
            applied = true;
            applyEdit();
            setTimeout(() => {
              clearTimeout(timer);
              resolve();
            }, 500);
          }
        } catch (e) {
          log.error("Agent bridge sync message error", {
            msg: e instanceof Error ? e.message : String(e),
          });
        }
      });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("collab websocket error"));
      });

      // Without a close listener, a server-side 4401 (expired/rejected token)
      // fires 'close' — not 'error' — and the promise hangs for the full
      // SYNC_TIMEOUT_MS before the timer fires.
      // Guard: if the update was already dispatched and the 500 ms settle timer
      // is running, a clean server-side close is not an error — the edit landed.
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        if (!applied) reject(new Error("collab websocket closed"));
        else resolve();
      });
    });
  } finally {
    // Remove the ydoc listener before closing so any internal Yjs update fired
    // during close doesn't try to send on an already-closed socket.
    if (registeredOnUpdate) ydoc.off("update", registeredOnUpdate);
    try { ws.close(); } catch { /* already closed */ }
  }
}
