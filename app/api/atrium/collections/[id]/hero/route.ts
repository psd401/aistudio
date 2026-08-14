/**
 * Atrium collection hero image (migration 178).
 *
 * `GET /api/atrium/collections/{id}/hero` — streams the section's header image.
 *
 * ## Why this is not `/api/images/[...key]`
 *
 * That route serves AI-generated CHAT images and authorizes them by validating
 * the caller owns the conversation embedded in the S3 key. A collection has no
 * conversation, so every hero would 404 there. Access to a section's artwork is
 * a collection question, so it is answered by the collection-access snapshot —
 * the same predicate that decides whether the section appears in the sidebar.
 *
 * The KEY is never accepted from the caller: it is read from the collection row
 * after the access check. A client-supplied key would make this an arbitrary
 * S3-read primitive scoped only by whatever prefix validation it happened to do.
 */

import { NextRequest } from "next/server";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { s3Store } from "@/lib/content/storage/s3-store";
import { collectionAccessSnapshot } from "@/lib/content/collection-access";
import { getOptionalRequester } from "@/actions/db/atrium/requester";
import { MAX_HERO_IMAGE_BYTES } from "@/lib/content/collection-hero-service";

/** S3 reads need the Node runtime; the app's default is fine but be explicit. */
export const runtime = "nodejs";

/** Guess the response content type from the stored key's extension. */
function contentTypeFor(key: string): string {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.atrium.collectionHero");
  const log = createLogger({ requestId, route: "api.atrium.collectionHero" });
  const { id } = await params;

  try {
    const requester = await getOptionalRequester(requestId);

    // ONE snapshot answers both questions. It already carries every collection
    // row (including `heroImageKey`), so the access check and the key lookup
    // come from the same read rather than a permission call followed by a
    // second query for a column we were already holding — this is the hot path
    // for every section landing page.
    //
    // Taking the key from the snapshot rather than the request is also what
    // keeps this route from being an arbitrary S3 read primitive.
    const access = await collectionAccessSnapshot(requester);
    const collection = access.byId.get(id);

    // Existence masking: a collection the caller may not enter is reported the
    // same as one that does not exist, matching every other Atrium read path.
    if (!collection || !access.allowedCollectionIds.has(id)) {
      timer({ status: "error", reason: "forbidden" });
      return new Response("Not Found", { status: 404 });
    }
    if (!collection.heroImageKey) {
      timer({ status: "success", reason: "no-image" });
      return new Response("Not Found", { status: 404 });
    }

    const bytes = await s3Store.getBytesBounded(
      collection.heroImageKey,
      MAX_HERO_IMAGE_BYTES
    );

    timer({ status: "success" });
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": contentTypeFor(collection.heroImageKey),
        "Content-Length": String(bytes.byteLength),
        // PRIVATE, not public: a personal collection's artwork must never be
        // cached by a shared proxy where the next viewer's access check is
        // skipped. `immutable` is safe because replacing a hero writes a NEW
        // key rather than overwriting this one.
        "Cache-Control": "private, max-age=3600, immutable",
        // The bytes are user-supplied; never let a browser re-interpret them as
        // markup regardless of what the extension claims.
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  } catch (error) {
    timer({ status: "error" });
    log.error("Failed to serve collection hero image", {
      collectionId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Not Found", { status: 404 });
  }
}
