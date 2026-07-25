/**
 * Bridge a Web Request/Response to a Node.js request handler.
 *
 * oidc-provider exposes a Node handler and its public interaction APIs accept
 * IncomingMessage/ServerResponse. Next App Router exposes Web Request/Response,
 * so both the provider catch-all and custom interaction routes use this bridge.
 */

import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"

export type NodeHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>
) => void | Promise<void>

export interface NodeHttpContext {
  request: IncomingMessage
  response: ServerResponse<IncomingMessage>
  close: () => void
}

function appendNodeHeader(
  headers: Headers,
  name: string,
  value: number | string | string[]
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      headers.append(name, item)
    }
    return
  }
  headers.set(name, String(value))
}

function responseMayHaveBody(method: string, status: number): boolean {
  return (
    method !== "HEAD" &&
    status !== 204 &&
    status !== 205 &&
    status !== 304 &&
    (status < 100 || status >= 200)
  )
}

function toBuffer(
  chunk: string | Uint8Array,
  encoding?: BufferEncoding
): Buffer {
  return typeof chunk === "string"
    ? Buffer.from(chunk, encoding)
    : Buffer.from(chunk)
}

/**
 * Invoke a Node handler and return its completed response as a Web Response.
 *
 * Resolution waits for both `response.end()` and the handler promise. This is
 * important for Koa/oidc-provider: resolving at `end()` while ignoring a later
 * callback rejection creates an unhandled rejection and can hide a failed
 * authorization request behind a partial response.
 */
export async function invokeNodeHttpHandler(
  request: Request,
  path: string,
  handler: NodeHttpHandler
): Promise<Response> {
  const context = await createNodeHttpContext(request, path)
  const { request: nodeRequest, response: nodeResponse } = context

  return new Promise<Response>((resolve, reject) => {
    const chunks: Buffer[] = []
    let handlerCompleted = false
    let responseEnded = false
    let settled = false

    const cleanup = () => {
      context.close()
    }

    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const resolveWhenComplete = () => {
      if (settled || !handlerCompleted || !responseEnded) return

      const headers = new Headers()
      for (const [name, value] of Object.entries(nodeResponse.getHeaders())) {
        if (value !== undefined) {
          appendNodeHeader(headers, name, value)
        }
      }

      const status = nodeResponse.statusCode
      const body = Buffer.concat(chunks)
      settled = true
      cleanup()
      resolve(
        new Response(
          responseMayHaveBody(request.method, status) && body.length > 0
            ? body
            : null,
          { status, headers }
        )
      )
    }

    nodeResponse.write = ((
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | (() => void),
      callback?: () => void
    ): boolean => {
      const encoding =
        typeof encodingOrCallback === "string"
          ? encodingOrCallback
          : undefined
      chunks.push(toBuffer(chunk, encoding))
      if (typeof encodingOrCallback === "function") {
        encodingOrCallback()
      }
      callback?.()
      return true
    }) as typeof nodeResponse.write

    nodeResponse.end = ((
      chunk?: string | Uint8Array | (() => void),
      encodingOrCallback?: BufferEncoding | (() => void),
      callback?: () => void
    ): ServerResponse<IncomingMessage> => {
      if (typeof chunk === "string" || chunk instanceof Uint8Array) {
        const encoding =
          typeof encodingOrCallback === "string"
            ? encodingOrCallback
            : undefined
        chunks.push(toBuffer(chunk, encoding))
      }
      if (typeof chunk === "function") {
        chunk()
      }
      if (typeof encodingOrCallback === "function") {
        encodingOrCallback()
      }
      callback?.()
      responseEnded = true
      resolveWhenComplete()
      return nodeResponse
    }) as typeof nodeResponse.end

    try {
      Promise.resolve(handler(nodeRequest, nodeResponse)).then(
        () => {
          handlerCompleted = true
          resolveWhenComplete()
        },
        rejectOnce
      )
    } catch (error) {
      rejectOnce(error)
    }
  })
}

/**
 * Build a Node request/response pair for oidc-provider public APIs that do not
 * themselves emit a response (for example `interactionDetails`).
 */
export async function createNodeHttpContext(
  request: Request,
  path: string
): Promise<NodeHttpContext> {
  const socket = new Socket()
  const nodeRequest = new IncomingMessage(socket)
  nodeRequest.method = request.method
  nodeRequest.url = path

  for (const [name, value] of request.headers.entries()) {
    nodeRequest.headers[name.toLowerCase()] = value
    nodeRequest.rawHeaders.push(name, value)
  }

  if (
    request.method === "POST" ||
    request.method === "PUT" ||
    request.method === "PATCH"
  ) {
    nodeRequest.push(Buffer.from(await request.arrayBuffer()))
  }
  nodeRequest.push(null)

  const nodeResponse = new ServerResponse(nodeRequest)
  return {
    request: nodeRequest,
    response: nodeResponse,
    close: () => socket.destroy(),
  }
}
