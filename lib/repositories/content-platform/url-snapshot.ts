import { createHash } from "node:crypto";
import { htmlToText } from "@/lib/agents/agent-tools/web-fetch";
import {
  deleteRepositoryObjectVersions,
  uploadRepositoryTextSource,
} from "@/lib/aws/s3-client";
import { sanitizeFileName } from "@/lib/aws/document-upload";
import { safeFetch } from "@/lib/security/safe-fetch";
import {
  registerCanonicalUpload,
  type CanonicalUploadRegistration,
} from "./ingestion-service";

const MAX_REDIRECTS = 5;
const MAX_URL_SOURCE_BYTES = 5 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 30_000;

function assertRepositoryUrlPolicy(url: URL): void {
  if (url.username || url.password) {
    throw new Error("URL source credentials are not allowed");
  }
  const expectedPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== expectedPort) {
    throw new Error("URL source must use the standard HTTP or HTTPS port");
  }
}

async function readBoundedText(
  response: Response,
  maximumBytes = MAX_URL_SOURCE_BYTES,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("URL source exceeds the canonical snapshot size limit");
  }
  if (!response.body) throw new Error("URL source returned no response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new Error("URL source exceeds the canonical snapshot size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Resolve, pin, and snapshot one public URL. Every redirect is revalidated by
 * safeFetch, response bytes are bounded, and executable markup is discarded.
 */
export async function fetchRepositoryUrlText(rawUrl: string): Promise<string> {
  let current = new URL(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      assertRepositoryUrlPolicy(current);
      const response = await safeFetch(current, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "text/html, text/plain;q=0.9",
          "Accept-Encoding": "identity",
          "User-Agent":
            "AIStudio-RepositoryBot/1.0 (+https://aistudio.psd401.ai)",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("URL redirect omitted its destination");
        if (redirects === MAX_REDIRECTS) {
          throw new Error("URL source exceeded the redirect limit");
        }
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        throw new Error(`URL source returned HTTP ${response.status}`);
      }
      const contentType = (
        response.headers.get("content-type") ?? "text/plain"
      ).toLowerCase();
      const contentEncoding = (
        response.headers.get("content-encoding") ?? "identity"
      ).toLowerCase();
      if (contentEncoding !== "identity") {
        await response.body?.cancel();
        throw new Error("URL source returned unsupported content encoding");
      }
      if (
        !contentType.startsWith("text/html") &&
        !contentType.startsWith("text/plain")
      ) {
        await response.body?.cancel();
        throw new Error("URL source did not return HTML or plain text");
      }
      const body = await readBoundedText(response);
      const text = contentType.startsWith("text/html")
        ? htmlToText(body).replace(/\s+/g, " ").trim()
        : body.trim();
      if (!text) throw new Error("URL source did not contain searchable text");
      return text;
    }
    throw new Error("URL source exceeded the redirect limit");
  } finally {
    clearTimeout(timeout);
  }
}

export async function registerCanonicalUrlSnapshot(input: {
  itemId: number;
  repositoryId: number;
  userId: number;
  name: string;
  url: string;
  traceId?: string;
}): Promise<CanonicalUploadRegistration> {
  const content = await fetchRepositoryUrlText(input.url);
  const originalFileName = sanitizeFileName(
    `${input.name.replace(/\.[^.]+$/, "") || "url-source"}.txt`,
  );
  const source = await uploadRepositoryTextSource({
    repositoryId: input.repositoryId,
    itemId: input.itemId,
    userId: input.userId,
    fileName: originalFileName,
    content,
  });
  try {
    return await registerCanonicalUpload({
      itemId: input.itemId,
      userId: input.userId,
      objectKey: source.key,
      originalFileName,
      declaredContentType: "text/plain",
      byteSize: source.byteSize,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      sourceKind: "url",
      traceId: input.traceId,
      metadata: {
        sourceUrlSha256: createHash("sha256")
          .update(input.url, "utf8")
          .digest("hex"),
      },
    });
  } catch (registrationError) {
    try {
      await deleteRepositoryObjectVersions(source.key);
    } catch (cleanupError) {
      throw new AggregateError(
        [registrationError, cleanupError],
        "Canonical URL registration and source cleanup both failed",
      );
    }
    throw registrationError;
  }
}
