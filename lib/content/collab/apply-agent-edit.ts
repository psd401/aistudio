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
import { signAgentCollabToken } from "./collab-token";
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

/**
 * Hostnames the agent bridge is permitted to connect to. The bridge always talks
 * to the SAME process's collab websocket server, so the only legitimate target is
 * loopback. ECS deployments that need a different host (rare) can extend this via
 * COLLAB_INTERNAL_HOST_ALLOWLIST (comma-separated). This blocks SSRF: a tampered
 * COLLAB_INTERNAL_URL (e.g. `ws://169.254.169.254/...` or an attacker WS host)
 * would otherwise receive a valid signed collab JWT in the `?token=` query string.
 */
const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];

function resolveCollabBaseUrl(): string {
  const base = process.env.COLLAB_INTERNAL_URL ?? `ws://127.0.0.1:${process.env.PORT ?? "3000"}`;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`COLLAB_INTERNAL_URL is not a valid URL: ${base}`);
  }
  // Only the websocket schemes — never http(s)/file/etc. — and the JWT must not
  // be carried to anything but a vetted internal host.
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`COLLAB_INTERNAL_URL must use ws:// or wss:// (got ${parsed.protocol})`);
  }
  const extra = (process.env.COLLAB_INTERNAL_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set([...DEFAULT_ALLOWED_HOSTS, ...extra]);
  if (!allowed.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `COLLAB_INTERNAL_URL host "${parsed.hostname}" is not allowed; ` +
        `set COLLAB_INTERNAL_HOST_ALLOWLIST to permit it`
    );
  }
  return base;
}

/**
 * Settle delay after dispatching the Yjs update before resolving the promise.
 *
 * KNOWN LIMITATION: this is heuristic, not acknowledgement-based. The y-protocols
 * sync handshake gives us no application-level ack that the SERVER applied our
 * update — only that we sent it. We therefore wait a fixed window for the update
 * frame to flush over the socket before closing it. Under ECS load or Redis
 * backpressure the default 500 ms may be insufficient; raise COLLAB_AGENT_SETTLE_MS
 * (see .env.example) for those deployments. A future improvement would replace this
 * with a real round-trip ack (server echoes a state vector covering our update).
 */
const AGENT_SETTLE_MS = Number(process.env.COLLAB_AGENT_SETTLE_MS) || 500;

/** Apply the agent's markdown to the live document via a short-lived y-sync client. */
export async function applyAgentEdit(input: AgentEditInput): Promise<void> {
  const { objectId, markdown, agentId, mode = "replace" } = input;
  const by = makeAuthorTag("agent", agentId);
  // Short-TTL token: this loopback bridge completes in ≤SYNC_TIMEOUT_MS (10s),
  // so a 30s grant is ample and shrinks the ALB-access-log replay window vs. the
  // 5-minute browser token (the token rides in the `?token=` URL — see collab-token.ts).
  const token = await signAgentCollabToken({ sub: `agent:${agentId}`, oid: objectId, w: true });

  // COLLAB_INTERNAL_URL allows overriding the loopback target in ECS task definitions
  // where PORT may differ from the value server.ts actually binds on. Validated to a
  // ws(s):// scheme + allowlisted host so a tampered value cannot exfiltrate the
  // signed collab JWT to an attacker-controlled or metadata-service endpoint (SSRF).
  const base = resolveCollabBaseUrl();
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
      // Guard readyState: if the socket is CLOSING/CLOSED when a Yjs update fires
      // (e.g. server-side close races the transaction), ws.send() throws
      // InvalidStateError outside the connect promise's try/catch. Only send when OPEN.
      if (ws.readyState !== WebSocket.OPEN) return;
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
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      const timer = setTimeout(() => {
        reject(new Error("collab sync timeout"));
      }, SYNC_TIMEOUT_MS);
      // Single resolution path so the settle timer and the close handler can't
      // BOTH resolve. Once the close handler resolves (the normal case — the
      // collab server closes the socket on last-conn cleanup before the settle
      // window elapses), the still-armed settle timer is cancelled, so it does
      // not fire a second (no-op) resolve after `finally` already tore down.
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        resolve();
      };

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
          // then allow time for the update to flush before resolving. Mark
          // `applied` ONLY after applyEdit() AND the settle timer both succeed:
          // if applyEdit() throws (e.g. ws.send() races OPEN->CLOSING and raises
          // InvalidStateError), `applied` stays false so the subsequent `close`
          // handler rejects rather than silently resolving an edit that never
          // transmitted (HTTP 200 with no edit landed).
          if (!applied && syncType === SYNC_STEP_2) {
            applyEdit();
            settleTimer = setTimeout(settle, AGENT_SETTLE_MS);
            applied = true;
          }
        } catch (e) {
          // A failure in the sync/apply path (the only branch that mutates the
          // doc) must FAIL the promise — not just log — so the bridge route
          // returns an error instead of a false HTTP 200. Previously this only
          // logged, so an InvalidStateError from ws.send() racing OPEN->CLOSING
          // left `applied` set by the old ordering and the close handler resolved
          // successfully (silent dropped edit). Log for observability AND reject.
          const msg = e instanceof Error ? e.message : String(e);
          log.error("Agent bridge sync/apply failed", { msg });
          clearTimeout(timer);
          reject(new Error(`collab sync apply failed: ${msg}`));
        }
      });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("collab websocket error"));
      });

      // Without a close listener, a server-side 4401 (expired/rejected token)
      // fires 'close' — not 'error' — and the promise hangs for the full
      // SYNC_TIMEOUT_MS before the timer fires.
      // Guard: if the update was already dispatched and the settle timer
      // (AGENT_SETTLE_MS) is running, a clean server-side close is not an error —
      // the edit landed.
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        if (!applied) reject(new Error("collab websocket closed"));
        else settle();
      });
    });
  } finally {
    // Remove the ydoc listener before closing so any internal Yjs update fired
    // during close doesn't try to send on an already-closed socket.
    if (registeredOnUpdate) ydoc.off("update", registeredOnUpdate);
    try { ws.close(); } catch { /* already closed */ }
  }
}
