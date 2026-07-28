import { describe, expect, test } from "bun:test"
import { agentRouterTestHelpers, createLogger } from "./index"
import { shouldPromoteToJob } from "./job-promotion"

const {
  normalizeChatEvent,
  cardClickMessageText,
  parseAgentCoreResult,
  totalAgentTokens,
  parseAsideInvocation,
  ownerSessionId,
  asideSessionId,
  invokeOwnerAgentWithDependencies,
  buildOwnerResponse,
  buildOwnerJobPromotionInput,
  extractIncomingMessage,
  btwSlashCommandId,
} = agentRouterTestHelpers

type OwnerHuman = Parameters<typeof invokeOwnerAgentWithDependencies>[0]
type OwnerUser = Parameters<typeof invokeOwnerAgentWithDependencies>[1]
type OwnerDependencies = Parameters<
  typeof invokeOwnerAgentWithDependencies
>[4]
type OwnerTurn = NonNullable<
  Awaited<ReturnType<typeof invokeOwnerAgentWithDependencies>>
>

const TEST_LOG = createLogger({ requestId: "agent-router-index-test" })

function ownerHuman(options?: {
  spaceType?: "DM" | "ROOM"
  messageText?: string
  slashCommandId?: string
  argumentText?: string
}): OwnerHuman {
  const spaceType = options?.spaceType ?? "DM"
  const messageText = options?.messageText ?? "What is the status?"
  return {
    chatEvent: {
      type: "MESSAGE",
      eventTime: "2026-07-27T12:00:00Z",
      space: { name: "spaces/owner-dm", type: spaceType },
      message: {
        name: "spaces/owner-dm/messages/one",
        text: messageText,
        ...(options?.argumentText !== undefined
          ? { argumentText: options.argumentText }
          : {}),
        sender: {
          name: "users/owner",
          displayName: "Owner",
          email: "owner@psd401.net",
          type: "HUMAN",
        },
        ...(options?.slashCommandId
          ? { slashCommand: { commandId: options.slashCommandId } }
          : {}),
        createTime: "2026-07-27T12:00:00Z",
      },
    },
    message: {
      name: "spaces/owner-dm/messages/one",
      text: messageText,
      ...(options?.argumentText !== undefined
        ? { argumentText: options.argumentText }
        : {}),
      sender: {
        name: "users/owner",
        displayName: "Owner",
        email: "owner@psd401.net",
        type: "HUMAN",
      },
      ...(options?.slashCommandId
        ? { slashCommand: { commandId: options.slashCommandId } }
        : {}),
      createTime: "2026-07-27T12:00:00Z",
    },
    attachments: [],
    isSharedSpace: spaceType === "ROOM",
    senderName: "users/owner",
    senderEmail: "owner@psd401.net",
    senderDisplayName: "Owner",
    messageText,
    spaceName: "spaces/owner-dm",
    threadName: "spaces/owner-dm/threads/one",
  }
}

const OWNER_USER: OwnerUser = {
  googleIdentity: "users/owner",
  email: "owner@psd401.net",
  displayName: "Owner",
  department: "Technology",
  workspacePrefix: "owner-a1b2c3d4",
  createdAt: "2026-07-01T00:00:00Z",
  lastActiveAt: "2026-07-27T12:00:00Z",
  sessionCount: 1,
  agentAccountStatus: "active",
}

const AGENT_RESULT: OwnerTurn["result"] = {
  response: "Here is the answer.",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  model: "us.anthropic.claude-sonnet-5",
  latencyMs: 50,
  modelCallCount: 1,
  durationMs: 50,
  nudged: false,
  messages: [],
  toolCalls: [],
}

function ownerDependencies(
  overrides: Partial<OwnerDependencies> = {}
): OwnerDependencies {
  return {
    fetchChatUploads: async () => {},
    isJobLockActive: async () => false,
    tryAcquireSessionLock: async () => "aside-lock",
    waitForSessionLock: async () => "main-lock",
    releaseSessionLock: async () => {},
    invokeAgentCore: async () => AGENT_RESULT,
    sendGoogleChatResponse: async () => {},
    ...overrides,
  }
}

describe("agent router event normalization", () => {
  test("normalizes Workspace common message events", () => {
    const event = normalizeChatEvent({
      chat: {
        eventTime: "2026-07-26T12:00:00Z",
        messagePayload: {
          space: { name: "spaces/one", type: "ROOM" },
          message: {
            name: "spaces/one/messages/one",
            text: "hello",
            sender: {
              name: "users/one",
              displayName: "User",
              email: "user@psd401.net",
              type: "HUMAN",
            },
            createTime: "2026-07-26T12:00:00Z",
          },
        },
      },
    })

    expect(event.type).toBe("MESSAGE")
    expect(event.space.name).toBe("spaces/one")
    expect(event.message?.text).toBe("hello")
  })

  test("synthesizes the sender envelope for added-to-space events", () => {
    const event = normalizeChatEvent({
      chat: {
        eventTime: "2026-07-26T12:00:00Z",
        user: {
          name: "users/one",
          displayName: "User",
          email: "user@psd401.net",
          type: "HUMAN",
        },
        addedToSpacePayload: {
          space: { name: "spaces/one", type: "ROOM" },
        },
      },
    })

    expect(event.type).toBe("ADDED_TO_SPACE")
    expect(event.message?.sender.email).toBe("user@psd401.net")
    expect(event.message?.text).toBe("")
  })

  test("preserves card intent and non-intent parameters", () => {
    expect(
      cardClickMessageText({
        actionMethodName: "fallback",
        parameters: [
          { key: "intent", value: "approve" },
          { key: "request", value: "42" },
        ],
      })
    ).toEqual({
      intent: "approve",
      text: "[button] intent=approve request=42",
      paramCount: 2,
    })
  })
})

describe("agent router result coercion", () => {
  test("coerces harness metadata and retains only non-empty messages", () => {
    const result = parseAgentCoreResult({
      result: "done",
      metadata: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 20,
        cache_write_input_tokens: 3,
        model: "zai.glm-5",
        failed: true,
        error_class: "OpenClawChatError",
        messages: [
          { role: "user", content: "question" },
          { role: "assistant", content: "" },
        ],
        tool_calls: [
          {
            name: "lookup",
            status: "timeout",
            duration_ms: 8,
            started_at: "2026-07-26T12:00:00Z",
            finished_at: "2026-07-26T12:00:01Z",
          },
          { name: "fallback", status: "unexpected" },
        ],
      },
    })

    expect(result.messages).toEqual([{ role: "user", content: "question" }])
    expect(result.toolCalls.map(toolCall => toolCall.status)).toEqual([
      "timeout",
      "success",
    ])
    expect(result.errorSource).toBe("harness")
    expect(totalAgentTokens(result)).toBe(37)
  })

  test("uses compatibility defaults for older harness responses", () => {
    const result = parseAgentCoreResult({})

    expect(result.response).toBe("No response from agent.")
    expect(result.model).toBe("unknown")
    expect(result.messages).toEqual([])
    expect(result.toolCalls).toEqual([])
    expect(result.failed).toBe(false)
  })
})

describe("/btw parsing and aside session identity", () => {
  test("parses the registered command id and extracts argumentText", () => {
    const human = ownerHuman({
      messageText: "/btw ignored fallback",
      argumentText: "What changed in the budget?",
      slashCommandId: btwSlashCommandId,
    })

    expect(parseAsideInvocation(human.message)).toEqual({
      messageText: "What changed in the budget?",
      source: "slash-command",
    })
  })

  test("parses the /btw text-prefix fallback without matching lookalikes", () => {
    expect(
      parseAsideInvocation(
        ownerHuman({ messageText: "  /btw   Check the calendar  " }).message
      )
    ).toEqual({
      messageText: "Check the calendar",
      source: "text-prefix",
    })
    expect(
      parseAsideInvocation(
        ownerHuman({ messageText: "/btwlater not a command" }).message
      )
    ).toBeNull()
  })

  test("derives a stable, distinct, AgentCore-valid sidecar id", () => {
    const previousBuildTag = process.env.AGENT_BUILD_TAG
    process.env.AGENT_BUILD_TAG = "0123456789ab-c0ffee00"
    try {
      const human = ownerHuman()
      const mainId = ownerSessionId(human, OWNER_USER)
      const firstAsideId = asideSessionId(human, OWNER_USER)
      const secondAsideId = asideSessionId(human, OWNER_USER)

      expect(firstAsideId).toBe(secondAsideId)
      expect(firstAsideId).not.toBe(mainId)
      expect(firstAsideId).toContain("-aside-")
      expect(firstAsideId.length).toBeGreaterThanOrEqual(33)
      expect(firstAsideId.length).toBeLessThanOrEqual(256)
      expect(firstAsideId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    } finally {
      if (previousBuildTag === undefined) {
        delete process.env.AGENT_BUILD_TAG
      } else {
        process.env.AGENT_BUILD_TAG = previousBuildTag
      }
    }
  })

  test("accepts command ID 3 in DMs and drops it at shared-space ingress", () => {
    const dm = ownerHuman({
      argumentText: "DM side question",
      slashCommandId: btwSlashCommandId,
    })
    const room = ownerHuman({
      spaceType: "ROOM",
      argumentText: "Shared-space side question",
      slashCommandId: btwSlashCommandId,
    })

    expect(extractIncomingMessage(dm.chatEvent, TEST_LOG)?.rawText).toBe(
      "DM side question"
    )
    expect(extractIncomingMessage(room.chatEvent, TEST_LOG)).toBeNull()
  })
})

describe("owner-DM aside routing and locks", () => {
  test("/btw bypasses main locks and uses only the aside lock/session", async () => {
    const human = ownerHuman({
      messageText: "/btw What is next?",
      argumentText: "What is next?",
      slashCommandId: btwSlashCommandId,
    })
    const acquired: string[] = []
    const invoked: string[] = []
    const released: string[] = []
    const turn = await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies({
        isJobLockActive: async () => {
          throw new Error("main job lock must not be consulted")
        },
        waitForSessionLock: async () => {
          throw new Error("main turn lock must not be consulted")
        },
        tryAcquireSessionLock: async sessionId => {
          acquired.push(sessionId)
          return "aside-lock"
        },
        invokeAgentCore: async (_message, _userId, sessionId) => {
          invoked.push(sessionId)
          return AGENT_RESULT
        },
        releaseSessionLock: async sessionId => {
          released.push(sessionId)
        },
      })
    )

    const expectedAsideId = asideSessionId(human, OWNER_USER)
    expect(turn?.prompt).toBe("What is next?")
    expect(turn?.sessionId).toBe(expectedAsideId)
    expect(turn?.isAside).toBe(true)
    expect(turn?.autoRouted).toBe(false)
    expect(acquired).toEqual([expectedAsideId])
    expect(invoked).toEqual([expectedAsideId])
    expect(released).toEqual([expectedAsideId])
  })

  test("auto-routes a plain owner-DM message when the main job is active", async () => {
    const human = ownerHuman({ messageText: "What time is the meeting?" })
    const turn = await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies({
        isJobLockActive: async sessionId => {
          expect(sessionId).toBe(ownerSessionId(human, OWNER_USER))
          return true
        },
      })
    )

    expect(turn?.sessionId).toBe(asideSessionId(human, OWNER_USER))
    expect(turn?.isAside).toBe(true)
    expect(turn?.autoRouted).toBe(true)
    const response = buildOwnerResponse(
      human,
      turn!.result,
      turn!.responsePrefix
    )
    expect(response).toStartWith("[aside]")
    expect(response).toContain("main task is still running")
    const promotion = buildOwnerJobPromotionInput(
      human,
      OWNER_USER,
      turn!
    )
    expect(promotion.acknowledgementPrefix).toContain(
      "main task is still running"
    )
    expect(promotion.responsePrefix).toBe("[aside] ")
  })

  test("plain messages still wait on the main turn lock when no job is active", async () => {
    const human = ownerHuman({ messageText: "Continue the main conversation" })
    let waitedSessionId = ""
    const turn = await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies({
        isJobLockActive: async () => false,
        tryAcquireSessionLock: async () => {
          throw new Error("aside lock must not be acquired")
        },
        waitForSessionLock: async sessionId => {
          waitedSessionId = sessionId
          return "main-lock"
        },
      })
    )

    const mainId = ownerSessionId(human, OWNER_USER)
    expect(waitedSessionId).toBe(mainId)
    expect(turn?.sessionId).toBe(mainId)
    expect(turn?.isAside).toBe(false)
  })
})

describe("owner-DM aside fallback, scope, and responses", () => {
  test("returns the existing busy reply when both main job and aside are busy", async () => {
    const human = ownerHuman({ messageText: "Quick question" })
    const responses: string[] = []
    let invoked = false
    const turn = await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies({
        isJobLockActive: async () => true,
        tryAcquireSessionLock: async () => null,
        invokeAgentCore: async () => {
          invoked = true
          return AGENT_RESULT
        },
        sendGoogleChatResponse: async (_space, _thread, text) => {
          responses.push(text)
        },
      })
    )

    expect(turn).toBeNull()
    expect(invoked).toBe(false)
    expect(responses).toEqual([
      "I'm currently busy processing another request. Please try again in a moment.",
    ])
  })

  test("keeps /btw text on the main route outside owner DMs", async () => {
    const human = ownerHuman({
      spaceType: "ROOM",
      messageText: "/btw This must not use the sidecar",
    })
    let waitedSessionId = ""
    let invokedPrompt = ""
    const turn = await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies({
        waitForSessionLock: async sessionId => {
          waitedSessionId = sessionId
          return "main-lock"
        },
        tryAcquireSessionLock: async () => {
          throw new Error("aside routing must be inactive in shared spaces")
        },
        invokeAgentCore: async (message, _userId, _sessionId) => {
          invokedPrompt = message
          return AGENT_RESULT
        },
      })
    )

    const mainId = ownerSessionId(human, OWNER_USER)
    expect(waitedSessionId).toBe(mainId)
    expect(turn?.sessionId).toBe(mainId)
    expect(turn?.isAside).toBe(false)
    expect(invokedPrompt).toBe("/btw This must not use the sidecar")
  })

  test("marks explicit aside replies and preserves the aside id for promotion", async () => {
    const human = ownerHuman({ messageText: "/btw Check deployment status" })
    const turn = await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies()
    )
    expect(turn).not.toBeNull()

    const promotableTurn: OwnerTurn = {
      ...turn!,
      result: {
        ...turn!.result,
        failed: true,
        errorClass: "ChatDeadlineExpired",
      },
    }
    expect(shouldPromoteToJob(promotableTurn.result.errorClass)).toBe(true)
    const promotion = buildOwnerJobPromotionInput(
      human,
      OWNER_USER,
      promotableTurn
    )
    expect(promotion.sessionId).toBe(asideSessionId(human, OWNER_USER))
    expect(promotion.acknowledgementPrefix).toBe("[aside] ")
    expect(promotion.responsePrefix).toBe("[aside] ")
    expect(
      buildOwnerResponse(human, turn!.result, turn!.responsePrefix)
    ).toStartWith("[aside] ")
  })
})
