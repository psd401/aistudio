import {
  clearGatewayToolsCache,
  executeWorkflowGatewayTool,
  getCallerBoundArgumentNames,
  isMutatingWorkflowToolName,
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
  toolPages?: Array<{ nextCursor?: string; tools: WorkflowGatewayTool[] }>
  tools?: WorkflowGatewayTool[]
}) {
  const encoder = new TextEncoder()
  let streamController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined
  const requests: RecordedRequest[] = []
  let toolsListPageIndex = 0
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
          result = options.toolPages?.[toolsListPageIndex] ?? {
            tools: options.tools ?? [],
          }
          toolsListPageIndex += 1
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

const roster = [
  {
    name: "get_example_schema",
    description: "Returns the example schema",
    inputSchema: { type: "object", properties: {} },
  },
]

describe("workflow gateway roster parsing", () => {
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

  it("classifies every state-changing workflow verb as mutating", () => {
    for (const verb of [
      "approve",
      "cancel",
      "create",
      "delete",
      "reject",
      "submit",
      "update",
    ]) {
      expect(isMutatingWorkflowToolName(`${verb}_example_request`)).toBe(true)
    }
    expect(isMutatingWorkflowToolName("get_example_request")).toBe(false)
    expect(isMutatingWorkflowToolName("list_example_requests")).toBe(false)
  })
})

describe("workflow gateway discovery requests", () => {
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

  it("keeps simultaneous request-scoped discoveries independent", async () => {
    const config = {
      url: "https://gateway.example/sse",
      token: "service-token",
    }
    const firstGateway = createGatewayFetch({ tools: roster })
    const secondRoster = [
      {
        name: "get_second_schema",
        description: "Returns a second schema",
        inputSchema: { type: "object", properties: {} },
      },
    ]
    const secondGateway = createGatewayFetch({ tools: secondRoster })

    const [first, second] = await Promise.all([
      listGatewayTools(
        config,
        firstGateway.fetchMock,
        new AbortController().signal
      ),
      listGatewayTools(
        config,
        secondGateway.fetchMock,
        new AbortController().signal
      ),
    ])

    expect(first).toEqual(roster)
    expect(second).toEqual(secondRoster)
    expect(
      firstGateway.requests.filter((request) => request.method === "GET")
    ).toHaveLength(1)
    expect(
      secondGateway.requests.filter((request) => request.method === "GET")
    ).toHaveLength(1)
  })

  it("follows every tools/list cursor and merges the bounded roster", async () => {
    const secondTool = {
      name: "process_future_packet",
      description: "Processes a future workflow packet",
      inputSchema: { type: "object", properties: {} },
    }
    const gateway = createGatewayFetch({
      toolPages: [
        { tools: roster, nextCursor: "page-2" },
        { tools: [secondTool] },
      ],
    })

    await expect(
      listGatewayTools(
        {
          url: "https://gateway.example/sse",
          token: "service-token",
        },
        gateway.fetchMock
      )
    ).resolves.toEqual([...roster, secondTool])
    expect(
      gateway.requests
        .filter((request) => request.body?.method === "tools/list")
        .map((request) => request.body?.params)
    ).toEqual([{}, { cursor: "page-2" }])
  })

  it("rejects duplicate tools and repeated cursors across pages", async () => {
    const config = {
      url: "https://gateway.example/sse",
      token: "service-token",
    }
    const duplicateGateway = createGatewayFetch({
      toolPages: [
        { tools: roster, nextCursor: "page-2" },
        { tools: roster },
      ],
    })
    await expect(
      listGatewayTools(config, duplicateGateway.fetchMock)
    ).rejects.toThrow(/duplicate/)

    const cursorGateway = createGatewayFetch({
      toolPages: [
        { tools: roster, nextCursor: "page-2" },
        { tools: [], nextCursor: "page-2" },
      ],
    })
    await expect(
      listGatewayTools(config, cursorGateway.fetchMock)
    ).rejects.toThrow(/repeated a cursor/)
  })
})

describe("workflow gateway execution", () => {
  it("discovers and calls a dynamic tool in the same MCP session", async () => {
    const dynamicToolName = ["new", "family", "action"].join("_")
    const gateway = createGatewayFetch({
      toolData: { success: true, family: "new" },
      tools: [
        {
          name: dynamicToolName,
          description: "A newly deployed workflow",
          inputSchema: {
            type: "object",
            properties: {
              requester_email: {
                type: "string",
                description: "Verified requester [caller-bound]",
              },
              value: { type: "string" },
            },
          },
        },
      ],
    })
    await expect(
      executeWorkflowGatewayTool(
        {
          url: "https://gateway.example/sse",
          token: "service-token",
        },
        dynamicToolName,
        (tool) => {
          const args: Record<string, unknown> = { value: "input" }
          for (const name of getCallerBoundArgumentNames(tool.inputSchema)) {
            args[name] = "owner@psd401.net"
          }
          return args
        },
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
          arguments: {
            value: "input",
            requester_email: "owner@psd401.net",
          },
        },
      })
    )
    expect(
      gateway.requests.filter((request) => request.method === "GET")
    ).toHaveLength(1)
    expect(
      gateway.requests
        .filter((request) =>
          ["tools/list", "tools/call"].includes(
            String(request.body?.method)
          )
        )
        .map((request) => request.body?.method)
    ).toEqual(["tools/list", "tools/call"])
  })

  it("ignores a stale discovery cache when binding an executing tool", async () => {
    const toolName = "process_rotated_packet"
    const config = {
      url: "https://gateway.example/sse",
      token: "service-token",
    }
    const cachedGateway = createGatewayFetch({
      tools: [
        {
          name: toolName,
          description: "Old schema",
          inputSchema: {
            type: "object",
            properties: {
              old_requester: {
                type: "string",
                description: "Old caller [caller-bound]",
              },
            },
          },
        },
      ],
    })
    await listGatewayTools(config, cachedGateway.fetchMock)

    const liveGateway = createGatewayFetch({
      tools: [
        {
          name: toolName,
          description: "Current schema",
          inputSchema: {
            type: "object",
            properties: {
              current_requester: {
                type: "string",
                description: "Current caller [caller-bound]",
              },
            },
          },
        },
      ],
    })
    await executeWorkflowGatewayTool(
      config,
      toolName,
      (tool) => {
        const args: Record<string, unknown> = {
          current_requester: "attacker@psd401.net",
        }
        for (const name of getCallerBoundArgumentNames(tool.inputSchema)) {
          args[name] = "owner@psd401.net"
        }
        return args
      },
      liveGateway.fetchMock
    )

    expect(
      liveGateway.requests.find(
        (request) => request.body?.method === "tools/call"
      )?.body
    ).toEqual(
      expect.objectContaining({
        params: {
          name: toolName,
          arguments: { current_requester: "owner@psd401.net" },
        },
      })
    )
  })
})
