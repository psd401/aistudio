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
import { randomUUID } from "node:crypto";
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

/**
 * Persist debounce window. Each room writes at most one DB row per window during
 * active editing, so a smaller value means more writes/minute per room. Override
 * with COLLAB_PERSIST_DEBOUNCE_MS (see .env.example); defaults to 1500 ms.
 *
 * Parsed with the same strict IIFE pattern as MAX_CONNS_PER_ROOM / MAX_FRAME_BYTES:
 * `Number(...) || 1500` would treat an explicit `0` (a valid "persist immediately"
 * value) as falsy and silently restore 1500. Only unset / blank / non-numeric /
 * negative fall back to the default; a deliberate 0 is honored.
 */
const PERSIST_DEBOUNCE_MS = ((): number => {
  const raw = process.env.COLLAB_PERSIST_DEBOUNCE_MS;
  if (raw === undefined || raw.trim() === "") return 1500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
})();

/**
 * Max concurrent websocket connections per document room. A single client
 * repeatedly opening sockets to one room would otherwise grow `DocEntry.conns`
 * (and its awareness map) without bound. Override with COLLAB_MAX_CONNS_PER_ROOM;
 * defaults to 50. Set to 0 to disable the cap.
 *
 * Parse explicitly rather than `Number(... ?? 50)`: `?? 50` only catches
 * null/undefined, NOT an empty string, and `Number("") === 0` would SILENTLY
 * disable the cap (a blank env var is a footgun, not an intentional "disable").
 * Here, only an explicit numeric value (including a deliberate 0) is honored;
 * unset / blank / non-numeric all fall back to 50.
 */
const MAX_CONNS_PER_ROOM = ((): number => {
  const raw = process.env.COLLAB_MAX_CONNS_PER_ROOM;
  if (raw === undefined || raw.trim() === "") return 50;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 50;
})();

/**
 * Max bytes for a single inbound websocket frame. Post-authentication, every
 * binary frame is handed to y-protocols' readSyncMessage, which allocates to
 * decode the embedded Yjs update — an authenticated user could otherwise send a
 * single ~100 MB frame and spike memory enough to OOM the ECS task, taking down
 * every concurrent collab session on it. A legitimate Yjs sync/update frame for
 * a document is small (KB-scale); 8 MB is generous headroom for a large paste +
 * the 512 KB agent-bridge ceiling while still bounding the per-frame allocation.
 * Override with COLLAB_MAX_FRAME_BYTES; 0 disables the cap. Parsed strictly (an
 * empty string must NOT collapse to 0 and silently disable the guard).
 */
const MAX_FRAME_BYTES = ((): number => {
  const raw = process.env.COLLAB_MAX_FRAME_BYTES;
  if (raw === undefined || raw.trim() === "") return 8 * 1024 * 1024;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 8 * 1024 * 1024;
})();

const REDIS_CHANNEL_PREFIX = "atrium:collab:";

/**
 * Per-process identity prefixed onto every Redis-published update so this
 * instance can recognise — and skip applying — its OWN messages when they loop
 * back through the pub/sub fan-out.
 *
 * Without it, an instance's local edit is published to Redis, received back by
 * its own subscriber, and re-applied with origin "redis". Because the broadcast
 * guard is `conn !== origin` and origin is the string "redis" (never a
 * WebSocket), the update is re-broadcast to ALL local connections including the
 * one that produced it — a self-echo that flickers the originating editor and
 * wastes bandwidth on every keystroke under multi-instance Redis mode. The 16
 * raw UUID bytes are prepended to the payload and stripped on receive.
 */
const INSTANCE_ID = randomUUID();
const INSTANCE_ID_BYTES: Buffer = Buffer.from(INSTANCE_ID.replace(/-/g, ""), "hex");
const INSTANCE_ID_LEN = INSTANCE_ID_BYTES.length; // 16

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
    // REDIS_TLS=1 is set when the ElastiCache cluster has transitEncryptionEnabled.
    // `tls: {}` tells ioredis to wrap the connection in TLS (same port 6379).
    ...(process.env.REDIS_TLS === "1" ? { tls: {} } : {}),
    // REDIS_PASSWORD is the ElastiCache AUTH token (injected from Secrets Manager).
    // Without it, any process that can reach 6379 in the VPC could read/write all
    // Yjs CRDT state. AUTH requires transit encryption, which REDIS_TLS provides.
    ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
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
    // Frames are `[16-byte instance id][update]`. Skip our OWN published frames
    // looping back through pub/sub — re-applying them would re-broadcast the
    // update to the local connection that originated it (self-echo flicker).
    if (
      message.length < INSTANCE_ID_LEN ||
      message.compare(INSTANCE_ID_BYTES, 0, INSTANCE_ID_LEN, 0, INSTANCE_ID_LEN) === 0
    ) {
      return;
    }
    const update = new Uint8Array(message.subarray(INSTANCE_ID_LEN));
    const entry = docs.get(docName);
    if (!entry) {
      // The document is not yet in `docs`, but it may be mid-load: getOrCreateDoc
      // sets `loading` BEFORE the async Postgres hydrate completes and only then
      // sets `docs`. A Redis update arriving in that window would otherwise be
      // dropped (the originating instance has the edit, this one never does ->
      // permanent CRDT divergence). Replay it onto the doc once loading resolves;
      // CRDT updates are commutative + idempotent, so applying after hydrate is safe.
      const inflight = loading.get(docName);
      if (inflight) {
        void inflight
          .then((loaded) => Y.applyUpdate(loaded.ydoc, update, "redis"))
          .catch((e) =>
            log.warn("Deferred redis update apply failed", {
              docName,
              error: e instanceof Error ? e.message : String(e),
            })
          );
      }
      return;
    }
    Y.applyUpdate(entry.ydoc, update, "redis");
    // Also schedule a (debounced) persist on the RECEIVING instance. The
    // ydoc "update" handler skips persist for origin === "redis" to avoid every
    // instance writing the same update, relying on the ORIGINATING instance to
    // persist. But if that instance crashes / is replaced (ECS rolling deploy,
    // OOM) before its debounce fires, the edit lives only in memory on the
    // receivers and is silently lost on the next cold load. Scheduling here too
    // means whichever instance's debounce fires first persists the converged
    // state; the trailing-edge debounce + idempotent saveDocState make the
    // duplicate writes harmless (last writer wins on identical CRDT state).
    schedulePersist(docName, entry);
  });
}

// Initialize Redis fan-out at module load, NOT per-document. ioredis retries the
// connection internally (it never gives up), so a transient broker outage at boot
// self-heals. Initializing inside getOrCreateDoc would instead permanently disable
// fan-out for the process if the very first document's init raced a Redis hiccup.
initRedis();

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

/**
 * Thrown by `getOrCreateDoc` when the content object no longer exists (hard-deleted,
 * or never existed): there is neither persisted `atrium_doc_state` NOR an object to
 * seed a fresh draft from. The connection handler catches this and rejects the
 * socket, so the doc-load path FAILS CLOSED post-delete — a still-valid pre-minted
 * collab token (≤ its short TTL) cannot open a deleted document's room and get an
 * empty editable doc. (New connections already fail closed at token-mint time via
 * the mint route's canView/loadByIdOrSlug 404; this closes the in-TTL window.)
 */
class CollabDocNotFoundError extends Error {
  constructor(docName: string) {
    super(`Collab document ${docName} no longer exists`);
    this.name = "CollabDocNotFoundError";
  }
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
        } else {
          // No persisted state AND no object to seed from ⇒ the content object does
          // not exist (hard-deleted, or never existed). FAIL CLOSED rather than
          // materialize an empty editable room for a non-existent object — a valid
          // pre-minted token would otherwise open a just-deleted doc within its TTL.
          // A brand-new document always has its content_objects row, so `seed` is
          // non-null and this never fires for a legitimately empty new doc.
          throw new CollabDocNotFoundError(docName);
        }
      }

      ydoc.on("update", (update: Uint8Array, origin: unknown) => {
        // The `origin === "init"` guard is a forward-safety net, not a live path
        // today: the hydrate/seed `Y.applyUpdate(..., "init")` calls above run
        // BEFORE this observer is attached, so they never reach here. It exists so
        // that if that ordering ever changes (e.g. a re-seed after attach), the
        // initial-load update is not broadcast/persisted back as a user edit.
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
          // Fire-and-forget, but never drop the rejection: a transient Redis
          // disconnect would otherwise surface as an unhandledRejection (warn or
          // crash depending on Node flags). `void` + `.catch` keeps fan-out
          // best-effort while logging the failure.
          void redisPub
            ?.publish(
              // Prefix the 16-byte instance id so this process can recognise +
              // skip its own frame when the pub/sub fan-out loops it back.
              Buffer.from(`${REDIS_CHANNEL_PREFIX}${docName}`),
              Buffer.concat([INSTANCE_ID_BYTES, Buffer.from(update)])
            )
            .catch((e) =>
              log.warn("Redis publish failed", {
                docName,
                error: e instanceof Error ? e.message : String(e),
              })
            );
          schedulePersist(docName, entry);
        }
      });

      docs.set(docName, entry);
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

/**
 * Reject (and close) a new connection when the room is already at the per-room
 * connection cap. Returns true when the connection was rejected so the caller can
 * bail. Disabled when MAX_CONNS_PER_ROOM is 0.
 */
function roomAtCapacity(entry: DocEntry, docName: string, ws: WebSocket): boolean {
  if (MAX_CONNS_PER_ROOM <= 0 || entry.conns.size < MAX_CONNS_PER_ROOM) return false;
  log.warn("Per-room connection limit reached, rejecting connection", {
    docName,
    limit: MAX_CONNS_PER_ROOM,
  });
  try { ws.close(4429, "Too many connections for this document"); } catch { /* already closing */ }
  return true;
}

/**
 * Pre-auth message buffering. Attaches a message listener SYNCHRONOUSLY (before
 * the async token-verify/doc-load) so the client's immediate SyncStep1 frame is
 * queued, not dropped, then replayed once the real handler is ready. Returns the
 * pending buffer, a setter to install the real frame processor, and `rejectConn`
 * — which MUST be called on every early-return rejection to detach the listener
 * and drop the buffer (otherwise each rejected socket pins a listener + buffer
 * until its fd closes: a connection-flood DoS lever).
 */
function attachPreAuthBuffer(
  ws: WebSocket,
  docName: string
): {
  pending: Uint8Array[];
  setProcessFrame: (fn: (u8: Uint8Array) => void) => void;
  rejectConn: (code?: number, reason?: string) => void;
} {
  const MAX_PENDING_FRAMES = 16;
  const pending: Uint8Array[] = [];
  let processFrame: ((u8: Uint8Array) => void) | null = null;
  // Hoisted so the buffer-overflow branch in onMessage can reuse the SAME
  // detach-listener-and-close path as every other rejection. Closing the socket
  // without detaching the listener (and dropping the buffer) would pin a listener
  // + buffer on each rejected fd until it closes — a connection-flood DoS lever.
  const rejectConn = (code?: number, reason?: string): void => {
    ws.off("message", onMessage);
    pending.length = 0;
    if (code !== undefined) {
      try { ws.close(code, reason); } catch { /* already closing */ }
    }
  };
  const onMessage = (data: Buffer): void => {
    // Bound per-frame allocation BEFORE decoding. A single oversized binary frame
    // (pre- or post-auth) handed to y-protocols' readSyncMessage would allocate
    // to decode the embedded update; an authenticated user sending a ~100 MB
    // frame could OOM the task. Reject + close oversized frames outright.
    if (MAX_FRAME_BYTES > 0 && data.byteLength > MAX_FRAME_BYTES) {
      log.warn("Inbound frame exceeds size limit, closing connection", {
        docName,
        bytes: data.byteLength,
        limit: MAX_FRAME_BYTES,
      });
      rejectConn(4009, "Frame too large");
      return;
    }
    const u8 = new Uint8Array(data);
    if (processFrame) {
      processFrame(u8);
    } else if (pending.length < MAX_PENDING_FRAMES) {
      pending.push(u8);
    } else {
      log.warn("Pre-auth frame buffer exceeded, closing connection", { docName });
      rejectConn(4429, "Too many pending frames");
    }
  };
  ws.on("message", onMessage);
  return {
    pending,
    setProcessFrame: (fn) => { processFrame = fn; },
    rejectConn,
  };
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

  // Buffer frames that arrive during the async auth/doc-load below (see helper).
  const { pending, setProcessFrame, rejectConn } = attachPreAuthBuffer(ws, docName);

  // Hoist the 'error' listener BEFORE the first await. The `ws` library emits
  // 'error' before 'close' on a TCP RST or TLS error; a socket error during the
  // async verifyCollabToken / getOrCreateDoc below would otherwise have NO listener,
  // and Node's EventEmitter throws a synchronous ERR_UNHANDLED_ERROR that the
  // Promise.resolve(...).catch(...) wrapper in server.ts cannot catch — crashing
  // the task and dropping every active collab session. Registered once here; the
  // 'cleaned' guard on the 'close' handler already prevents double-cleanup.
  ws.on("error", (err: Error) =>
    log.warn("Collab socket error", { docName, error: err.message })
  );

  const claims = await verifyCollabToken(token);
  if (!claims || !docName || claims.oid !== docName) {
    log.warn("Rejected collab connection", { docName, hasClaims: !!claims });
    rejectConn(4401, "Unauthorized");
    return;
  }
  const canWrite = claims.w;

  let entry: DocEntry;
  try {
    entry = await getOrCreateDoc(docName);
  } catch (err) {
    if (err instanceof CollabDocNotFoundError) {
      // Expected post-delete (or a bad id): the object is gone. Fail closed with a
      // "not found" close code, logged at info — this is not a server fault.
      log.info("Collab doc no longer exists; rejecting connection", { docName });
      rejectConn(4404, "Not found");
      return;
    }
    log.error("Failed to load collab doc, closing socket", {
      docName,
      error: err instanceof Error ? err.message : String(err),
    });
    rejectConn(4500, "Server error");
    return;
  }

  // Per-room connection cap: bound DocEntry.conns so a single client cannot
  // exhaust memory by repeatedly opening sockets to the same room.
  // roomAtCapacity already closes the socket; just release the pre-auth listener.
  if (roomAtCapacity(entry, docName, ws)) {
    rejectConn();
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

  const processFrame = (u8: Uint8Array): void => {
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
  // Install the real frame processor; buffered pre-auth frames are replayed below.
  setProcessFrame(processFrame);

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
        // Identity-checked delete: a connection arriving DURING the async save
        // calls getOrCreateDoc, gets THIS still-live entry, and adds itself to
        // entry.conns. An identity-blind `docs.delete(docName)` would then orphan
        // that entry (docs no longer maps docName -> entry, so the next connection
        // builds a fresh DocEntry from DB — split-brain: two in-memory instances
        // for one document). Only evict if the map still points at us.
        .finally(() => {
          if (docs.get(docName) === entry) docs.delete(docName);
        });
    }
  };
  // The 'error' listener was hoisted before the awaits above (a socket error
  // during auth/doc-load must not throw ERR_UNHANDLED_ERROR). Only the close
  // handler is registered here.
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

/**
 * Graceful shutdown: flush every live room's pending state to Postgres.
 *
 * Persistence is normally trailing-edge debounced (PERSIST_DEBOUNCE_MS). On an
 * ECS rolling deploy / scale-in / OOM, the process receives SIGTERM with pending
 * debounce timers still queued — abandoning them would lose up to the last
 * PERSIST_DEBOUNCE_MS window of edits for every actively-edited room. This cancels
 * each room's timer and forces a final synchronous-best-effort save before exit.
 *
 * Called from the custom server's SIGTERM/SIGINT handler (server.ts / voice-server.js)
 * BEFORE closeDatabase(), so the pool is still open for the final writes. Idempotent
 * and best-effort: a failed save for one room is logged and does not block the others.
 */
export async function shutdownCollab(): Promise<void> {
  // Snapshot first: saveDocState is async and other handlers may mutate `docs`
  // (e.g. a closing connection's cleanup) while we await.
  const entries = [...docs.entries()];
  if (entries.length === 0) return;
  log.info("Flushing collab rooms on shutdown", { rooms: entries.length });
  await Promise.allSettled(
    entries.map(async ([docName, entry]) => {
      if (entry.persistTimer) {
        clearTimeout(entry.persistTimer);
        entry.persistTimer = null;
      }
      try {
        await saveDocState(
          docName,
          Y.encodeStateAsUpdate(entry.ydoc),
          entry.markdown ?? undefined
        );
      } catch (e) {
        log.error("Shutdown persist failed", {
          docName,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })
  );
}

/**
 * Register the collab flush on a process-global hook so instrumentation.ts's
 * SIGTERM handler can AWAIT it before closeDatabase() — even though that handler
 * lives in a different module instance (the prod collab code runs from a separate
 * esbuild bundle, and `globalThis` is the only state both share within the process).
 *
 * Awaiting matters: instrumentation closes the DB pool and calls process.exit(0);
 * a fire-and-forget flush would race the pool teardown and lose the final writes.
 * The hook is idempotent (shutdownCollab snapshots `docs` and no-ops when empty),
 * so it is safe for both instrumentation AND the custom-server handlers to invoke.
 */
declare global {
  var __atriumCollabShutdown: (() => Promise<void>) | undefined;
}
globalThis.__atriumCollabShutdown = shutdownCollab;
