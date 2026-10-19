/**
 * GET /api/nexus/documents/[...key] — authenticated download for a file Nexus
 * generated in a conversation (Issue #1898).
 *
 * Why not a presigned S3 URL (what `documents.create` returns on the agent
 * surface, and what `/api/export-download` proxies):
 *
 *  - A presigned URL is a bearer credential. Putting one in a chat tool result
 *    writes it into the model's context and the persisted message, where anyone
 *    who later obtains that text can fetch the file with no session at all.
 *  - It expires (one hour), so the download card in a reloaded conversation
 *    would be dead — and the DoD requires the card to keep working after a
 *    reload.
 *  - It cannot be re-authorized. This route re-checks ownership on EVERY
 *    request, so revoking access to a conversation revokes its files too.
 *
 * Ownership is derived from the object key itself: conversation-scoped keys are
 * `v2/nexus-documents/{conversationId}/{requestId}/{name}.{ext}`, strictly
 * validated by `isConversationScopedDocumentKey` (the request id is its own
 * segment, so the basename is exactly the filename the card advertises), and
 * the conversation is then loaded with
 * `getConversationById(conversationId, userId)` — which filters on `user_id`, so
 * a non-owner gets `null` and this route answers 404 (not 403: a 403 would
 * confirm the file exists). This mirrors `/api/images/[...key]`, which gates
 * generated images the same way.
 *
 * Unlike the images route, the bytes are STREAMED through this handler rather
 * than redirecting to a presigned URL, so no S3 credential ever reaches the
 * browser.
 */

import { type NextRequest, NextResponse } from "next/server";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getServerSession } from "@/lib/auth/server-session";
import { getCurrentUserAction } from "@/actions/db/get-current-user-action";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { getConversationById } from "@/lib/db/drizzle";
import { Settings } from "@/lib/settings-manager";
import { conversationIdFromDocumentKey } from "@/lib/ai/document-generation-service";

export const runtime = "nodejs";
// Generated documents are small, but a cold S3 read plus streaming needs room.
export const maxDuration = 60;

/**
 * 50 MB cap, matching `/api/export-download`. `generateDocument` already bounds
 * the INPUT at 1,000,000 characters, so this is a second, independent ceiling on
 * what a single request can pull into the ECS task.
 */
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * Served Content-Type per extension. The upstream object's own Content-Type is
 * NOT trusted (object metadata is writer-controlled), and an unknown extension
 * is refused earlier by the key validation — so this map is exhaustive for every
 * key that can reach here.
 */
const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  md: "text/markdown; charset=utf-8",
  // Deliberately text/plain: the body is model-authored, and serving it as
  // text/html from this origin would make it executable in the user's session.
  html: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};

let s3ClientCache: S3Client | null = null;
async function getS3Client(): Promise<S3Client> {
  if (s3ClientCache) return s3ClientCache;
  const s3Config = await Settings.getS3();
  s3ClientCache = new S3Client({ region: s3Config.region || "us-west-2" });
  return s3ClientCache;
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not Found" }, { status: 404 });
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Validate the key shape and prove the caller owns the conversation it names.
 *
 * Returns the conversation id on success, or the response to send. Key shape is
 * checked BEFORE any DB or S3 work so traversal, foreign prefixes and non-UUID
 * segments are all rejected in one place.
 */
async function authorizeDocumentKey(
  s3Key: string,
  log: ReturnType<typeof createLogger>
): Promise<{ conversationId: string } | { response: NextResponse }> {
  const conversationId = conversationIdFromDocumentKey(s3Key);
  if (!conversationId) {
    log.warn("Rejected malformed Nexus document key");
    return { response: notFound() };
  }

  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess) {
    return { response: unauthorized() };
  }
  const userId = currentUser.data.user.id;

  // `getConversationById` filters on user_id, so a conversation belonging to
  // someone else is indistinguishable from one that does not exist. 404 rather
  // than 403: a 403 would confirm the file exists.
  const conversation = await getConversationById(conversationId, userId);
  if (!conversation) {
    log.warn("Nexus document access denied — conversation not owned by caller", {
      conversationId,
      userId,
    });
    return { response: notFound() };
  }
  return { conversationId };
}

/** Read the object from S3 and stream it back as an attachment. */
async function serveDocumentObject(args: {
  bucket: string;
  s3Key: string;
  conversationId: string;
  log: ReturnType<typeof createLogger>;
  timer: (data: Record<string, unknown>) => void;
}): Promise<NextResponse> {
  const { bucket, s3Key, conversationId, log, timer } = args;
  const filename = s3Key.slice(s3Key.lastIndexOf("/") + 1);
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const contentType =
    EXTENSION_CONTENT_TYPE[extension] ?? "application/octet-stream";

  const s3 = await getS3Client();
  const object = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: s3Key })
  );
  const bytes = object.ContentLength;
  if (bytes !== undefined && bytes > MAX_DOCUMENT_BYTES) {
    log.warn("Nexus document too large to serve", { bytes, conversationId });
    timer({ status: "error", reason: "too-large" });
    return NextResponse.json(
      { error: "This file is too large to download." },
      { status: 413 }
    );
  }

  // `transformToWebStream` is available on the Node SDK's streaming body.
  const body = (
    object.Body as
      | { transformToWebStream?: () => ReadableStream<Uint8Array> }
      | undefined
  )?.transformToWebStream?.();
  if (!body) {
    log.error("S3 body did not expose a web stream", { conversationId });
    timer({ status: "error", reason: "no-stream" });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }

  timer({ status: "success" });
  log.info("Nexus document served", { conversationId, bytes });

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    // The basename IS the filename the card advertises — the request id lives
    // in its own key segment, never as a prefix here — so the browser saves the
    // name the user was shown. It is [\w-]+.ext by construction
    // (`safeBaseName`), so it needs no quoting escape, and the key validation
    // re-proves it on every request.
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (bytes !== undefined) headers["Content-Length"] = String(bytes);
  return new NextResponse(body, { headers });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.nexus.documents.get");
  const log = createLogger({ requestId, route: "api.nexus.documents.get" });

  const { key: keyParts } = await params;
  const s3Key = (keyParts ?? []).join("/");

  const session = await getServerSession();
  if (!session?.sub) {
    timer({ status: "error", reason: "unauthorized" });
    return unauthorized();
  }

  const authorized = await authorizeDocumentKey(s3Key, log);
  if ("response" in authorized) {
    timer({ status: "error", reason: "denied" });
    return authorized.response;
  }
  const { conversationId } = authorized;

  const bucket = process.env.DOCUMENTS_BUCKET_NAME;
  if (!bucket) {
    log.error("DOCUMENTS_BUCKET_NAME is not configured");
    timer({ status: "error", reason: "misconfigured" });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }

  try {
    return await serveDocumentObject({
      bucket,
      s3Key,
      conversationId,
      log,
      timer,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    // A missing object is a 404, not a 502: the conversation is the caller's, so
    // the file was deleted or expired out of the bucket.
    if (name === "NoSuchKey" || name === "NotFound") {
      log.warn("Nexus document no longer in storage", { conversationId });
      timer({ status: "error", reason: "missing-object" });
      return notFound();
    }
    log.error("Nexus document download failed", {
      conversationId,
      errorName: name,
      error: error instanceof Error ? error.message : String(error),
    });
    timer({ status: "error" });
    return NextResponse.json(
      { error: "Failed to download the file" },
      { status: 502 }
    );
  }
}
