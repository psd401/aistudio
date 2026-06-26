/**
 * Atrium collaboration server (Hocuspocus)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). The real-time sync server that rebuilds
 * Proof's collab engine in-house: a Hocuspocus instance multiplexed onto the app's
 * websocket transport (same process/port as the app + voice — see server.ts /
 * voice-server.js), persisting to Postgres (atrium_doc_state) and fanning out
 * across ECS tasks via Redis when configured.
 *
 * - Auth: a short-TTL collab token (collab-token.ts) minted per document after a
 *   canView/canEdit check; read-only viewers get `connection.readOnly`.
 * - Load: hydrate the Y.Doc from atrium_doc_state, or SEED it on first open from
 *   the draft's markdown (stamped with the creator's author tag — an agent draft
 *   seeds purple, a human draft green).
 * - Store: persist the encoded Y.Doc (debounced by Hocuspocus) back to Postgres.
 * - Scale: Redis extension only when REDIS_HOST is set, so local dev runs
 *   single-process (in-memory) and prod fans out across tasks.
 *
 * Imports the pure-ESM Yjs/TipTap stack (via markdown-bridge) and is not
 * jest-loadable; the dev path (bun server.ts) exercises it, and the prod path
 * loads it from a bundled CJS handler (scripts/build-collab-ws-handler.mjs).
 */

import type { IncomingMessage } from "node:http";
import type WebSocket from "ws";
import { Hocuspocus } from "@hocuspocus/server";
import { Redis } from "@hocuspocus/extension-redis";
import * as Y from "yjs";
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

/** Resolve the author tag a freshly-seeded draft should carry (creator's). */
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

  // Read the current version's canonical markdown from S3 (source.md). Absent /
  // unreadable -> seed an empty doc rather than failing the connection.
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

let server: Hocuspocus | null = null;

/** Lazily build the Hocuspocus singleton (avoids side effects at import time). */
function getServer(): Hocuspocus {
  if (server) return server;

  const extensions =
    process.env.REDIS_HOST
      ? [
          new Redis({
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT ?? 6379),
          }),
        ]
      : [];

  server = new Hocuspocus({
    name: "atrium-collab",
    extensions,

    async onAuthenticate(data) {
      const claims = await verifyCollabToken(data.token);
      if (!claims || claims.oid !== data.documentName) {
        // Throwing rejects the connection (Hocuspocus closes it 4401-style).
        throw new Error("Unauthorized collab connection");
      }
      // Viewers connect read-only; only canEdit sessions may mutate the doc.
      data.connectionConfig.readOnly = !claims.w;
      return { userId: claims.sub };
    },

    async onLoadDocument(data) {
      const existing = await loadDocState(data.documentName);
      if (existing) {
        Y.applyUpdate(data.document, new Uint8Array(existing.yState));
        return data.document;
      }
      // First open: seed from the draft markdown, then persist so subsequent
      // loads are fast and every client converges on the same seed.
      const seed = await seedAuthorAndMarkdown(data.documentName);
      if (!seed) return data.document; // object vanished; hand back empty doc.
      const seeded = seedYDocFromMarkdown(seed.markdown, seed.by);
      const update = Y.encodeStateAsUpdate(seeded);
      Y.applyUpdate(data.document, update);
      await saveDocState(data.documentName, update, seed.markdown);
      return data.document;
    },

    async onStoreDocument(data) {
      // Persist the authoritative encoded state. markdown projection is left to
      // the seed / agent-bridge / client-snapshot paths (see doc-state-store).
      const update = Y.encodeStateAsUpdate(data.document);
      await saveDocState(data.documentName, update);
    },
  });

  return server;
}

/**
 * Route an upgraded websocket to the Atrium collab server. Mirrors
 * `handleVoiceConnection` — called from server.ts (dev) and the bundled CJS
 * handler loaded by voice-server.js (prod).
 */
export async function handleCollabConnection(
  ws: WebSocket,
  req: IncomingMessage
): Promise<void> {
  getServer().handleConnection(ws as never, req as never);
}

/**
 * The Hocuspocus singleton, for server-side writers (the agent bridge) that need
 * `openDirectConnection` to mutate the same live Y.Doc clients are editing.
 */
export function getCollabServer(): Hocuspocus {
  return getServer();
}
