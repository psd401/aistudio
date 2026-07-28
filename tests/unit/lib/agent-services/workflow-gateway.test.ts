import {
  clearGatewayToolsCache,
  executeWorkflowGatewayTool,
  getCallerBoundArgumentNames,
  listGatewayTools,
  parseGatewayToolsList,
  parseSseFrames,
  resolveGatewayEndpoint,
  unwrapWorkflowToolResult,
  WorkflowGatewayClient,
  WORKFLOW_SSE_LIMITS,
  type WorkflowGatewayTool,
} from "@/lib/agent-services/workflow-gateway"
import type { safeFetch } from "@/lib/security/safe-fetch"

interface RecordedRequest {
  body: Record<string, unknown> | null
  method: string | undefined
  url: string
}

function createGatewayFetch(options: {
  toolData?: unknown
  tools?: WorkflowGatewayTool[]
}) {
  const encoder = new TextEncoder()
  let streamController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined
  const requests: RecordedRequest[] = []
  const fetchMock = jest.fn(
    async (
      input: string | URL,
      init?: Parameters<typeof safeFetch>[1]
    ): Promise<Response> => {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null
      requests.push({
        url: String(input),
        method: init?.method,
        body,
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

      if (typeof body?.id === "number") {
        let result: unknown = { protocolVersion: "2024-11-05" }
        if (body.method === "tools/list") {
          result = { tools: options.tools ?? [] }
        } else if (body.method === "tools/call") {
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify(options.toolData ?? { success: true }),
              },
            ],
          }
        }
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
      return { ok: true, status: 202, body: null } as Response
    }
  )
  return {
    fetchMock: fetchMock as unknown as typeof safeFetch,
    requests,
  }
}

beforeEach(() => {
  clearGatewayToolsCache()
})

afterEach(() => {
  clearGatewayToolsCache()
})

describe("workflow gateway SSE boundary", () => {
  it("keeps every established hardening limit unchanged", () => {
    expect(WORKFLOW_SSE_LIMITS).toEqual({
      rawBytes: 4 * 1024 * 1024,
      chunkBytes: 256 * 1024,
      bufferBytes: 256 * 1024,
      frameBytes: 128 * 1024,
      lineBytes: 64 * 1024,
      dataBytes: 128 * 1024,
      frames: 1_000,
      resultBytes: 256 * 1024,
      headerTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
      requestTimeoutMs: 60_000,
      totalTimeoutMs: 150_000,
    })
  })

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
          WORKFLOW_SSE_LIMITS.frameBytes
        )}\n\n`
      )
    ).toThrow(/too large/)
  })

  it("detaches the caller abort listener when closed", () => {
    const signal = new AbortController().signal
    const add = jest.spyOn(signal, "addEventListener")
    const remove = jest.spyOn(signal, "removeEventListener")
    const client = new WorkflowGatewayClient(
      "https://gateway.example/sse",
      "token",
      undefined,
      signal
    )
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    })
    client.close()
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  })

  it("pins announced message endpoints to the configured HTTPS origin", () => {
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
  })

  it("unwraps a bounded MCP tool response", () => {
    expect(
      unwrapWorkflowToolResult({
        content: [{ type: "text", text: '{"success":true}' }],
      })
    ).toEqual({ isError: false, data: { success: true } })
  })
})

describe("workflow gateway discovery", () => {
  const roster = [
    {
      name: "get_example_schema",
      description: "Returns the example schema",
      inputSchema: { type: "object", properties: {} },
    },
  ]

  it("parses tools/list definitions without a static tool map", () => {
    expect(parseGatewayToolsList({ tools: roster })).toEqual(roster)
    expect(() =>
      parseGatewayToolsList({
        tools: [{ ...roster[0] }, { ...roster[0] }],
      })
    ).toThrow(/duplicate/)
  })

  it("extracts every top-level caller-bound schema argument", () => {
    expect(
      getCallerBoundArgumentNames({
        type: "object",
        properties: {
          requester_email: {
            type: "string",
            description: "Verified request owner [caller-bound]",
          },
          subject_email: {
            type: "string",
            description: "The employee being evaluated",
          },
          approver_email: {
            type: "string",
            description: "[caller-bound] verified approver",
          },
        },
      })
    ).toEqual(["requester_email", "approver_email"])
  })

  it("caches a tools/list roster for repeated discovery", async () => {
    const gateway = createGatewayFetch({ tools: roster })
    const config = {
      url: "https://gateway.example/sse",
      token: "service-token",
    }

    await expect(
      listGatewayTools(config, gateway.fetchMock)
    ).resolves.toEqual(roster)
    await expect(
      listGatewayTools(config, gateway.fetchMock)
    ).resolves.toEqual(roster)
    expect(
      gateway.requests.filter((request) => request.method === "GET")
    ).toHaveLength(1)
    expect(
      gateway.requests.filter(
        (request) => request.body?.method === "tools/list"
      )
    ).toHaveLength(1)
  })

  it("calls a dynamically named roster tool without an AI Studio allowlist", async () => {
    const dynamicToolName = ["new", "family", "action"].join("_")
    const gateway = createGatewayFetch({
      toolData: { success: true, family: "new" },
    })
    await expect(
      executeWorkflowGatewayTool(
        {
          url: "https://gateway.example/sse",
          token: "service-token",
        },
        dynamicToolName,
        { value: "input" },
        gateway.fetchMock
      )
    ).resolves.toEqual({
      isError: false,
      data: { success: true, family: "new" },
    })
    expect(
      gateway.requests.find(
        (request) => request.body?.method === "tools/call"
      )?.body
    ).toEqual(
      expect.objectContaining({
        params: {
          name: dynamicToolName,
          arguments: { value: "input" },
        },
      })
    )
  })
})
