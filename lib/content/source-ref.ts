/**
 * Typed Atrium content provenance contracts.
 *
 * External create surfaces use these schemas so `content_objects.source_ref`
 * never becomes an arbitrary JSON metadata bag. The capture variant intentionally
 * records only content-level correlation data; recorder steps, DOM text, selectors,
 * keystrokes, screenshots, and page titles do not belong here.
 */

import { z } from "zod";
import type { SourceRef } from "@/lib/db/schema";

export const CAPTURE_SOURCE_ORIGIN_LIMIT = 20;
export const CAPTURE_PROVIDER_MAX_LENGTH = 64;
export const CAPTURE_EXTERNAL_ID_MAX_LENGTH = 200;
export const CAPTURE_CLIENT_VERSION_MAX_LENGTH = 64;

const boundedIdentifier = (field: string, max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
      `${field} must be a bounded identifier without whitespace`
    );

/**
 * Accept an HTTP(S) URL but retain only its origin. Paths, queries, and fragments
 * are deliberately discarded so capture provenance cannot become browsing
 * history. Credentials and non-network schemes are rejected.
 */
export function normalizeCaptureSourceOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("sourceOrigins entries must be valid absolute URLs");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("sourceOrigins entries must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("sourceOrigins entries must not contain credentials");
  }
  return parsed.origin;
}

const sourceOriginSchema = z
  .string()
  .max(2048)
  .transform((value, ctx) => {
    try {
      return normalizeCaptureSourceOrigin(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Invalid source origin",
      });
      return z.NEVER;
    }
  });

export const captureSourceRefSchema = z
  .object({
    type: z.literal("capture"),
    provider: boundedIdentifier(
      "provider",
      CAPTURE_PROVIDER_MAX_LENGTH
    ),
    externalId: boundedIdentifier(
      "externalId",
      CAPTURE_EXTERNAL_ID_MAX_LENGTH
    ),
    clientSurface: z.enum(["browser", "mac"]),
    clientVersion: boundedIdentifier(
      "clientVersion",
      CAPTURE_CLIENT_VERSION_MAX_LENGTH
    ),
    capturedAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
    sourceOrigins: z
      .array(sourceOriginSchema)
      .max(CAPTURE_SOURCE_ORIGIN_LIMIT)
      .transform((origins) => [...new Set(origins)])
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.sourceOrigins?.length &&
      process.env.ATRIUM_CAPTURE_SOURCE_ORIGINS_ENABLED === "false"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceOrigins"],
        message: "Source-origin retention is disabled by district policy",
      });
    }
  });

/**
 * All established source-ref variants remain accepted for compatibility. Every
 * object is strict so unknown fields cannot smuggle arbitrary telemetry into the
 * provenance column.
 */
export const contentSourceRefSchema = z.union([
  z
    .object({
      type: z.literal("upload"),
      uploadId: boundedIdentifier("uploadId", 200),
      filename: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("object"),
      objectId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat"),
      conversationId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("okf"),
      generator: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ type: z.literal("none") }).strict(),
  captureSourceRefSchema,
]);

// Compile-time drift guard: the runtime schema and persisted JSONB union must
// describe the same shape.
const _sourceRefTypeGuard = {
  type: "none",
} satisfies z.infer<typeof contentSourceRefSchema> & SourceRef;
void _sourceRefTypeGuard;

export function captureAuditDetails(
  sourceRef: SourceRef | undefined
): {
  sourceProvider: string;
  sourceExternalId: string;
  clientSurface: "browser" | "mac";
} | null {
  if (sourceRef?.type !== "capture") return null;
  return {
    sourceProvider: sourceRef.provider,
    sourceExternalId: sourceRef.externalId,
    clientSurface: sourceRef.clientSurface,
  };
}
