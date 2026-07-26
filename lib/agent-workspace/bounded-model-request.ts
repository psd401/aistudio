const MAX_REQUEST_BYTES = 4 * 1024 * 1024

export class ModelRequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message)
    this.name = "ModelRequestBodyError"
  }
}

function parseDeclaredLength(headers: Pick<Headers, "get">): number | null {
  const raw = headers.get("content-length")
  if (raw === null) return null
  if (!/^\d+$/.test(raw)) {
    throw new ModelRequestBodyError("Invalid Content-Length", 400)
  }
  const length = Number(raw)
  if (!Number.isSafeInteger(length)) {
    throw new ModelRequestBodyError("Invalid Content-Length", 400)
  }
  if (length > MAX_REQUEST_BYTES) {
    throw new ModelRequestBodyError("Model request is too large", 413)
  }
  return length
}

/** Read at most MAX_REQUEST_BYTES, cancelling before an over-limit body is joined. */
export async function readBoundedModelRequest(request: {
  body: ReadableStream<Uint8Array<ArrayBufferLike>> | null
  headers: Pick<Headers, "get">
}): Promise<Uint8Array<ArrayBuffer>> {
  const contentType = request.headers.get("content-type")
  if (
    contentType &&
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new ModelRequestBodyError("Model request must be JSON", 400)
  }
  const declaredLength = parseDeclaredLength(request.headers)
  if (!request.body) {
    throw new ModelRequestBodyError("Invalid model request size", 400)
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array<ArrayBufferLike>[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel("request body limit exceeded")
        throw new ModelRequestBodyError("Model request is too large", 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0 || (declaredLength !== null && total !== declaredLength)) {
    throw new ModelRequestBodyError("Invalid model request size", 400)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}
