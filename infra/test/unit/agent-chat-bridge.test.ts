process.env.ROUTER_QUEUE_URL = "https://sqs.test/queue"
process.env.EXPECTED_OIDC_SUBJECT = "1234567890"
process.env.EXPECTED_OIDC_EMAIL = "pubsub-push@example.iam.gserviceaccount.com"
process.env.EXPECTED_PUBSUB_SUBSCRIPTION =
  "projects/example/subscriptions/chat-events"

const sendMock = jest.fn()
jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    send = sendMock
  },
  SendMessageCommand: class {
    constructor(readonly input: unknown) {}
  },
}))

import type { APIGatewayProxyEventV2 } from "aws-lambda"

// The lambda throws at MODULE level when its four env vars are missing, so it
// must not be imported until the assignments above have run. A static `import`
// cannot express that: ES import declarations are hoisted, and the CommonJS
// emit jest runs hoists the `require` with them — under SWC (the transform
// since ts-jest stopped working on TypeScript 7) the require would execute
// first and the module would throw before a single test ran. Load it lazily
// instead, which is correct under any transform rather than relying on one
// compiler's statement ordering.
type BridgeHandler = (
  event: APIGatewayProxyEventV2
) => Promise<{ statusCode: number; body: string }>
let handler: BridgeHandler

// Indirect specifier: under `moduleResolution: nodenext` a literal relative
// `import()` must carry a `.js` extension (TS2835), but jest resolves the real
// `index.ts` and would not find `index.js`. Going through a variable keeps the
// runtime path jest can resolve, with the shape pinned by the cast below.
const BRIDGE_MODULE = "../../lambdas/agent-chat-bridge/index"

beforeAll(async () => {
  ;({ handler } = (await import(BRIDGE_MODULE)) as { handler: BridgeHandler })
})

function event(
  claims: Record<string, string | boolean>,
  subscription = "projects/example/subscriptions/chat-events"
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "POST /chat",
    rawPath: "/chat",
    rawQueryString: "",
    headers: {},
    requestContext: {
      accountId: "account",
      apiId: "api",
      domainName: "api.test",
      domainPrefix: "api",
      http: {
        method: "POST",
        path: "/chat",
        protocol: "HTTP/1.1",
        sourceIp: "203.0.113.10",
        userAgent: "Google-PubSub",
      },
      requestId: "request-1",
      routeKey: "POST /chat",
      stage: "$default",
      time: "now",
      timeEpoch: Date.now(),
      authorizer: { jwt: { claims, scopes: [] } },
    },
    body: JSON.stringify({
      subscription,
      message: { data: "e30=" },
    }),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2
}

const expectedClaims = {
  sub: "1234567890",
  email: "pubsub-push@example.iam.gserviceaccount.com",
  email_verified: true,
}

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({})
})

describe("agent Chat bridge identity binding", () => {
  it.each([
    [{ ...expectedClaims, sub: "attacker" }],
    [{ ...expectedClaims, email: "attacker@example.iam.gserviceaccount.com" }],
    [{ ...expectedClaims, email_verified: false }],
  ])(
    "rejects a token that is not the configured push principal",
    async (claims) => {
      const response = await handler(event(claims))
      expect(response).toEqual({ statusCode: 403, body: "forbidden" })
      expect(sendMock).not.toHaveBeenCalled()
    }
  )

  it("rejects an envelope from another subscription", async () => {
    const response = await handler(
      event(expectedClaims, "projects/attacker/subscriptions/forged")
    )
    expect(response).toEqual({ statusCode: 403, body: "forbidden" })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("forwards only the pinned identity and subscription", async () => {
    const response = await handler(event(expectedClaims))
    expect(response).toEqual({ statusCode: 204, body: "" })
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})
