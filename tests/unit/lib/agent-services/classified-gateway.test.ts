import {
  executeClassifiedGatewayTool,
  ClassifiedGatewayClient,
  CLASSIFIED_SSE_LIMITS,
  parseSseFrames,
  resolveGatewayEndpoint,
  unwrapClassifiedToolResult,
} from "@/lib/agent-services/classified-gateway"
import type { safeFetch } from "@/lib/security/safe-fetch"

function defineClassifiedEvaluationGatewayBoundarySuite1Part1() {
  it("parses complete SSE frames and preserves partial input", () => {
    expect(
      parseSseFrames(
        "event: endpoint\ndata: /messages?id=1\n\n" +
          "event: message\ndata: {\"id\":1}\n\n" +
          "event: message\ndata: partial"
      )
    ).toEqual({
      frames: [
        { event: "endpoint", data: "/messages?id=1" },
        { event: "message", data: '{"id":1}' },
      ],
      rest: "event: message\ndata: partial",
    })
  })

  it("rejects oversized frames before JSON parsing", () => {
    expect(() =>
      parseSseFrames(
        `event: message\ndata: ${"x".repeat(
          CLASSIFIED_SSE_LIMITS.frameBytes,
        )}\n\n`,
      ),
    ).toThrow(/too large/)
  })

  it("detaches the caller abort listener when closed", () => {
    const signal = new AbortController().signal
    const add = jest.spyOn(signal, "addEventListener")
    const remove = jest.spyOn(signal, "removeEventListener")
    const client = new ClassifiedGatewayClient(
      "https://gateway.example/sse",
      "token",
      undefined,
      signal,
    )
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    })
    client.close()
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  })

  it("binds announced message endpoints to the configured HTTPS origin", () => {
    expect(
      resolveGatewayEndpoint(
        "https://gateway.example/sse",
        "/messages?session=1"
      ).toString()
    ).toBe("https://gateway.example/messages?session=1")
    expect(() =>
      resolveGatewayEndpoint(
        "https://gateway.example/sse",
        "https://attacker.example/messages"
      )
    ).toThrow(/outside/)
    expect(() =>
      resolveGatewayEndpoint(
        "https://gateway.example/sse",
        "http://gateway.example/messages"
      )
    ).toThrow(/outside/)
  })

  it("unwraps the bounded MCP tool response", () => {
    expect(
      unwrapClassifiedToolResult({
        content: [{ type: "text", text: '{"success":true}' }],
      })
    ).toEqual({ isError: false, data: { success: true } })
  })

  }

function defineClassifiedEvaluationGatewayBoundarySuite1Part2() {it("runs initialize and a tool call over pinned fetch requests", async () => {
    const encoder = new TextEncoder()
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined
    const requests: Array<{
      url: string
      method: string | undefined
      authorization: string | null
    }> = []
    const fetchMock = jest.fn(
      async (
        input: string | URL,
        init?: Parameters<typeof safeFetch>[1]
      ): Promise<Response> => {
        const url = String(input)
        requests.push({
          url,
          method: init?.method,
          authorization:
            (init?.headers as Record<string, string> | undefined)
              ?.Authorization ?? null,
        })
        if (init?.method === "GET") {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller
              controller.enqueue(
                encoder.encode(
                  "event: endpoint\ndata: /messages?session=1\n\n"
                )
              )
            },
          })
          return {
            ok: true,
            status: 200,
            body: stream,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "content-type"
                  ? "text/event-stream"
                  : null,
            },
          } as unknown as Response
        }
        const body = JSON.parse(String(init?.body)) as {
          id?: number
          method: string
        }
        if (typeof body.id === "number") {
          const result =
            body.method === "tools/call"
              ? {
                  content: [
                    {
                      type: "text",
                      text: '{"success":true,"envelopeId":"e1"}',
                    },
                  ],
                }
              : { protocolVersion: "2024-11-05" }
          streamController?.enqueue(
            encoder.encode(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result,
              })}\n\n`
            )
          )
        }
        return {
          ok: true,
          status: 202,
          body: null,
        } as Response
      }
    )

    await expect(
      executeClassifiedGatewayTool(
        { url: "https://gateway.example/sse", token: "service-token" },
        "get_classified_evaluation_schema",
        {},
        fetchMock as unknown as typeof safeFetch
      )
    ).resolves.toEqual({
      isError: false,
      data: { success: true, envelopeId: "e1" },
    })
    expect(requests.every((item) => item.authorization === "Bearer service-token")).toBe(
      true
    )
    expect(requests.map((item) => item.url)).toEqual([
      "https://gateway.example/sse",
      "https://gateway.example/messages?session=1",
      "https://gateway.example/messages?session=1",
      "https://gateway.example/messages?session=1",
    ])
  })
}

const defineClassifiedEvaluationGatewayBoundarySuite1 = () => {
  defineClassifiedEvaluationGatewayBoundarySuite1Part1()
  defineClassifiedEvaluationGatewayBoundarySuite1Part2()
};

describe("classified evaluation gateway boundary", defineClassifiedEvaluationGatewayBoundarySuite1)
