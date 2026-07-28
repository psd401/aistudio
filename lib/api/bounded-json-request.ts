export type BoundedJsonRequestErrorCode =
  | "INVALID_JSON"
  | "PAYLOAD_TOO_LARGE";

export class BoundedJsonRequestError extends Error {
  constructor(
    public readonly code: BoundedJsonRequestErrorCode,
    public readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
    this.name = "BoundedJsonRequestError";
  }
}

interface JsonBodyRequest {
  body: ReadableStream<Uint8Array<ArrayBufferLike>> | null;
  headers: Pick<Headers, "get">;
}

interface BoundedJsonRequestOptions {
  /**
   * Value returned for an absent or zero-byte body. Omit this option when an
   * empty body should remain an INVALID_JSON error.
   */
  emptyBodyValue?: unknown;
}

function hasEmptyBodyValue(
  options: BoundedJsonRequestOptions | undefined,
): options is Required<BoundedJsonRequestOptions> {
  return (
    options !== undefined &&
    Object.prototype.hasOwnProperty.call(options, "emptyBodyValue")
  );
}

function validateDeclaredLength(
  headers: Pick<Headers, "get">,
  maximumBytes: number,
): number | null {
  const rawLength = headers.get("content-length");
  if (rawLength === null) return null;
  if (!/^\d+$/.test(rawLength)) {
    throw new BoundedJsonRequestError(
      "INVALID_JSON",
      400,
      "Invalid Content-Length",
    );
  }

  const declaredLength = Number(rawLength);
  if (!Number.isSafeInteger(declaredLength)) {
    throw new BoundedJsonRequestError(
      "INVALID_JSON",
      400,
      "Invalid Content-Length",
    );
  }
  if (declaredLength > maximumBytes) {
    throw new BoundedJsonRequestError(
      "PAYLOAD_TOO_LARGE",
      413,
      "Request payload is too large",
    );
  }
  return declaredLength;
}

/**
 * Read and parse a JSON request without buffering more than `maximumBytes`.
 *
 * `Content-Length` is only an early rejection hint. The stream itself is always
 * counted so chunked bodies and understated headers cannot bypass the limit.
 */
export async function parseBoundedJsonRequest(
  request: JsonBodyRequest,
  maximumBytes: number,
  options?: BoundedJsonRequestOptions,
): Promise<unknown> {
  const declaredLength = validateDeclaredLength(request.headers, maximumBytes);
  if (!request.body) {
    if (hasEmptyBodyValue(options)) {
      return options.emptyBodyValue;
    }
    throw new BoundedJsonRequestError(
      "INVALID_JSON",
      400,
      "Request body must be valid JSON",
    );
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array<ArrayBufferLike>[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("request body limit exceeded");
        throw new BoundedJsonRequestError(
          "PAYLOAD_TOO_LARGE",
          413,
          "Request payload is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0 && hasEmptyBodyValue(options)) {
    return options.emptyBodyValue;
  }
  if (totalBytes === 0 || (declaredLength !== null && declaredLength !== totalBytes)) {
    throw new BoundedJsonRequestError(
      "INVALID_JSON",
      400,
      "Request body must be valid JSON",
    );
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoundedJsonRequestError(
      "INVALID_JSON",
      400,
      "Request body must be valid JSON",
    );
  }
}
