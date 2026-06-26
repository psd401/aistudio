/**
 * Atrium collaboration server (y-websocket protocol)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). The real-time sync server that rebuilds
 * Proof's collab engine in-house. It speaks the y-websocket binary protocol
 * (y-protocols/sync + /awareness) over the app's existing websocket transport
 * (same process/port as the app + voice — see server.ts / voice-server.js).
 *
 * Why not Hocuspocus: Hocuspocus v4 routes through `crossws`, whose Node adapter
 * throws under Bun ("incompatible environment"), and our dev server runs under Bun
 * (`bun run server.ts`). This hand-rolled y-protocol server is runtime-agnostic
 * (works under Bun AND Node) and is the same protocol TipTap's Collaboration
 * extension + y-websocket's `WebsocketProvider` speak.
 *
 * - Auth: a short-TTL collab token (collab-token.ts) passed as the `?token=` query
 *   param, minted per document after a canView/canEdit check. The connection is
 *   rejected unless the token's `oid` matches the requested room (= object id).
 *   Read-only sessions (token `w=false`) may sync state but their inbound updates
 *   are ignored server-side.
 * - Load/seed: the Y.Doc hydrates from Postgres (atrium_doc_state) or, on first
 *   open, is SEEDED from the draft markdown stamped with the creator's author tag
 *   (agent draft -> purple, human draft -> green), then persisted.
 * - Persist: debounced on change -> atrium_doc_state (y_state + markdown projection).
 * - Scale: when REDIS_HOST is set, doc updates are published to / applied from a
 *   Redis pub/sub channel so multiple ECS tasks converge (local dev runs without it).
 */

import type { IncomingMessage } from "node:http";
import { parse as parseUrl } from "node:url";
import type WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import Redis from "ioredis";
import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentObjects } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { s3Store } from "@/lib/content/storage/s3-store";
import { versionService } from "@/lib/content/version-service";
import { seedYDocFromMarkdown } from "./markdown-bridge";
import { loadDocState, saveDocState } from "./doc-state-store";
import { verifyCollabToken } from "./collab-token";
import { makeAuthorTag } from "./provenance";

const log = createLogger({ context: "atrium-collab" });

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP_1 = 0; // y-protocols/sync messageYjsSyncStep1
const PERSIST_DEBOUNCE_MS = 1500;
const REDIS_CHANNEL_PREFIX = "atrium:collab:";

interface DocEntry {
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<WebSocket>;
  /** awareness client ids owned by each connection (for cleanup on close). */
  awarenessIds: Map<WebSocket, Set<number>>;
  persistTimer: ReturnType<typeof setTimeout> | null;
  markdown: string | null;
}

const docs = new Map<string, DocEntry>();
const loading = new Map<string, Promise<DocEntry>>();

// ---------------------------------------------------------------------------
// Redis pub/sub (cross-instance fan-out). Lazily initialized when REDIS_HOST set.
// ---------------------------------------------------------------------------
let redisPub: Redis | null = null;
let redisReady = false;

function initRedis(): void {
  if (redisReady || !process.env.REDIS_HOST) return;
  redisReady = true;
  const opts = {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: false,
    maxRetriesPerRequest: null,
  };
  redisPub = new Redis(opts);
  redisPub.on("error", (err: Error) =>
    log.warn("Redis pub error", { error: err.message })
  );
  const sub = new Redis(opts);
  sub.on("error", (err: Error) =>
    log.warn("Redis sub error", { error: err.message })
  );
  sub.psubscribe(`${REDIS_CHANNEL_PREFIX}*`).catch((e) =>
    log.error("Redis psubscribe failed", { error: e instanceof Error ? e.message : String(e) })
  );
  // Binary payloads arrive via the *Buffer event variant.
  sub.on("pmessageBuffer", (_pattern: Buffer, channel: Buffer, message: Buffer) => {
    const docName = channel.toString("utf8").slice(REDIS_CHANNEL_PREFIX.length);
    const entry = docs.get(docName);
    if (entry) Y.applyUpdate(entry.ydoc, new Uint8Array(message), "redis");
  });
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------
function schedulePersist(docName: string, entry: DocEntry): void {
  // Trailing-edge debounce: reschedule on every update so the most recent
  // state is always what gets persisted, not an arbitrary prefix of the burst.
  if (entry.persistTimer) clearTimeout(entry.persistTimer);
  entry.persistTimer = setTimeout(() => {
    entry.persistTimer = null;
    void saveDocState(
      docName,
      Y.encodeStateAsUpdate(entry.ydoc),
      entry.markdown ?? undefined
    ).catch((e) =>
      log.error("Persist failed", { docName, error: e instanceof Error ? e.message : String(e) })
    );
  }, PERSIST_DEBOUNCE_MS);
}

/** Resolve the author tag + markdown a freshly-seeded draft should carry. */
async function seedAuthorAndMarkdown(
  objectId: string
): Promise<{ by: string; markdown: string } | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          createdByActor: contentObjects.createdByActor,
          createdByAgentId: contentObjects.createdByAgentId,
          ownerUserId: contentObjects.ownerUserId,
        })
        .from(contentObjects)
        .where(eq(contentObjects.id, objectId))
        .limit(1),
    "collab.seedAuthor"
  );
  const obj = rows[0];
  if (!obj) return null;
  const by =
    obj.createdByActor === "agent"
      ? makeAuthorTag("agent", obj.createdByAgentId ?? "agent")
      : makeAuthorTag("human", obj.ownerUserId);

  let markdown = "";
  try {
    const current = await versionService.current(objectId);
    if (current) {
      markdown = await s3Store.getText(
        s3Store.key(objectId, current.versionNumber, "source.md")
      );
    }
  } catch (error) {
    log.warn("Seed markdown unavailable; seeding empty doc", {
      objectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { by, markdown };
}

async function getOrCreateDoc(docName: string): Promise<DocEntry> {
  const existing = docs.get(docName);
  if (existing) return existing;
  const inflight = loading.get(docName);
  if (inflight) return inflight;

  const promise = (async (): Promise<DocEntry> => {
    try {
      const ydoc = new Y.Doc();
      const awareness = new awarenessProtocol.Awareness(ydoc);
      const entry: DocEntry = {
        ydoc,
        awareness,
        conns: new Set(),
        awarenessIds: new Map(),
        persistTimer: null,
        markdown: null,
      };

      // Hydrate from Postgres, or seed from the draft markdown on first open. Apply
      // with origin "init" so the update handler (attached after) doesn't broadcast
      // or persist the initial load back.
      const state = await loadDocState(docName);
      if (state) {
        Y.applyUpdate(ydoc, new Uint8Array(state.yState), "init");
        entry.markdown = state.markdown;
      } else {
        const seed = await seedAuthorAndMarkdown(docName);
        if (seed) {
          const seeded = seedYDocFromMarkdown(seed.markdown, seed.by);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seeded), "init");
          entry.markdown = seed.markdown;
          await saveDocState(docName, Y.encodeStateAsUpdate(ydoc), seed.markdown);
        }
      }

      ydoc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === "init") return;
        // Broadcast to local connections (except the originator).
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.writeUpdate(enc, update);
        const msg = encoding.toUint8Array(enc);
        for (const conn of entry.conns) {
          if (conn !== origin && conn.readyState === 1) conn.send(msg);
        }
        // Fan out to other instances + persist (only for locally-originated edits;
        // redis-origin updates were already persisted by the originating instance).
        if (origin !== "redis") {
          redisPub?.publish(
            Buffer.from(`${REDIS_CHANNEL_PREFIX}${docName}`),
            Buffer.from(update)
          );
          schedulePersist(docName, entry);
        }
      });

      docs.set(docName, entry);
      initRedis();
      return entry;
    } finally {
      // Always clear the in-flight cache whether the load succeeded or threw,
      // so a transient DB error doesn't permanently poison this document room.
      loading.delete(docName);
    }
  })();

  loading.set(docName, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Connection handler (called from server.ts / voice-server.js on WS upgrade)
// ---------------------------------------------------------------------------
function send(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState === 1) ws.send(data);
}

export async function handleCollabConnection(
  ws: WebSocket,
  req: IncomingMessage
): Promise<void> {
  const { pathname, query } = parseUrl(req.url || "", true);
  const docName = decodeURIComponent(
    (pathname || "").split("/").findLast((segment) => segment.length > 0) ?? ""
  );
  const rawToken = query.token;
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

  // CRITICAL: attach the message listener SYNCHRONOUSLY, before the async setup
  // (token verify + doc load). A client sends its first SyncStep1 immediately on
  // open; without this, that frame arrives during the awaits below with no listener
  // attached and is dropped — the server never replies with SyncStep2, so a raw
  // client (e.g. the agent bridge) never syncs. Frames are queued until the real
  // handler is ready, then replayed.
  let processFrame: ((u8: Uint8Array) => void) | null = null;
  const MAX_PENDING_FRAMES = 16;
  const pending: Uint8Array[] = [];
  const onMessage = (data: Buffer): void => {
    const u8 = new Uint8Array(data);
    if (processFrame) {
      processFrame(u8);
    } else if (pending.length < MAX_PENDING_FRAMES) {
      pending.push(u8);
    } else {
      log.warn("Pre-auth frame buffer exceeded, closing connection", { docName });
      try { ws.close(4429, "Too many pending frames"); } catch { /* already closing */ }
    }
  };
  ws.on("message", onMessage);

  const claims = await verifyCollabToken(token);
  if (!claims || !docName || claims.oid !== docName) {
    log.warn("Rejected collab connection", { docName, hasClaims: !!claims });
    try { ws.close(4401, "Unauthorized"); } catch { /* already closed */ }
    return;
  }
  const canWrite = claims.w;

  let entry: DocEntry;
  try {
    entry = await getOrCreateDoc(docName);
  } catch (err) {
    log.error("Failed to load collab doc, closing socket", {
      docName,
      error: err instanceof Error ? err.message : String(err),
    });
    try { ws.close(4500, "Server error"); } catch { /* already closing */ }
    return;
  }
  entry.conns.add(ws);
  entry.awarenessIds.set(ws, new Set());

  // Track which awareness client ids this connection introduced, so we can clear
  // them when it closes.
  const onAwarenessChange = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ): void => {
    const ids = entry.awarenessIds.get(ws);
    if (origin === ws && ids) {
      for (const id of changes.added) ids.add(id);
      for (const id of changes.removed) ids.delete(id);
    }
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    if (changed.length === 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(entry.awareness, changed)
    );
    const msg = encoding.toUint8Array(enc);
    for (const conn of entry.conns) send(conn, msg);
  };
  entry.awareness.on("update", onAwarenessChange);

  processFrame = (u8: Uint8Array): void => {
    try {
      const decoder = decoding.createDecoder(u8);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        // Read-only guard: a non-writer may only request state (SyncStep1); its
        // SyncStep2/Update messages are ignored so it cannot mutate the doc.
        if (!canWrite) {
          const peek = decoding.createDecoder(u8);
          decoding.readVarUint(peek);
          if (decoding.readVarUint(peek) !== SYNC_STEP_1) return;
        }
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, enc, entry.ydoc, ws);
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
      } else if (messageType === MESSAGE_AWARENESS) {
        // Read-only connections may still broadcast cursor/presence awareness;
        // awareness is separate from doc mutations and should not be gated on canWrite.
        awarenessProtocol.applyAwarenessUpdate(
          entry.awareness,
          decoding.readVarUint8Array(decoder),
          ws
        );
      }
    } catch (error) {
      log.error("Collab message error", {
        docName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    entry.conns.delete(ws);
    entry.awareness.off("update", onAwarenessChange);
    const ids = entry.awarenessIds.get(ws);
    if (ids && ids.size > 0) {
      awarenessProtocol.removeAwarenessStates(entry.awareness, [...ids], "conn-closed");
    }
    entry.awarenessIds.delete(ws);
    if (entry.conns.size === 0) {
      // Always persist the final state and evict from the in-memory map, regardless
      // of whether a pending persist timer exists. If the timer was running, cancel
      // it to avoid a second (potentially staler) save racing the one below.
      if (entry.persistTimer) {
        clearTimeout(entry.persistTimer);
        entry.persistTimer = null;
      }
      // Move docs.delete into .finally() so a new connection that arrives
      // after the delete but before the DB write completes will re-load from
      // the committed Postgres state rather than racing with stale in-memory state.
      saveDocState(
        docName,
        Y.encodeStateAsUpdate(entry.ydoc),
        entry.markdown ?? undefined
      )
        .catch((e) =>
          log.error("Cleanup persist failed", {
            docName,
            error: e instanceof Error ? e.message : String(e),
          })
        )
        .finally(() => docs.delete(docName));
    }
  };
  // The `ws` library emits 'error' before 'close' on a TCP RST or TLS error.
  // Without an 'error' listener, Node.js throws an unhandled ERR_UNHANDLED_ERROR
  // and terminates the process. The 'cleaned' guard already prevents double-execution.
  ws.on("error", (err: Error) =>
    log.warn("Collab socket error", { docName, error: err.message })
  );
  ws.once("close", cleanup);

  // SyncStep1: ask the client for its state and offer ours.
  const syncEnc = encoding.createEncoder();
  encoding.writeVarUint(syncEnc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(syncEnc, entry.ydoc);
  send(ws, encoding.toUint8Array(syncEnc));

  // Send current awareness states to the newcomer.
  const states = entry.awareness.getStates();
  if (states.size > 0) {
    const aEnc = encoding.createEncoder();
    encoding.writeVarUint(aEnc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      aEnc,
      awarenessProtocol.encodeAwarenessUpdate(entry.awareness, [...states.keys()])
    );
    send(ws, encoding.toUint8Array(aEnc));
  }

  // Replay frames that arrived during setup (e.g. the client's initial SyncStep1).
  for (const u8 of pending) processFrame(u8);
  pending.length = 0;
}
