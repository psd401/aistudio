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
  addOptionalAgentContext,
  buildAgentInvocationContext,
  sendGoogleChatResponseWithDependencies,
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
type ChatResponseDependencies = Parameters<
  typeof sendGoogleChatResponseWithDependencies
>[2]

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

function chatResponseDependencies(
  overrides: Partial<ChatResponseDependencies> = {}
): ChatResponseDependencies {
  return {
    createMessage: async () => {},
    resolveDmSpace: async () => null,
    recordFailure: async () => {},
    ...overrides,
  }
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

describe("Google Chat response delivery", () => {
  test("sets the reply option whenever a thread name is present", async () => {
    const requests: Array<
      Parameters<ChatResponseDependencies["createMessage"]>[0]
    > = []

    await sendGoogleChatResponseWithDependencies(
      {
        spaceName: "spaces/room",
        threadName: "spaces/room/threads/thread-1",
        text: "Threaded response",
        deliveryContext: {},
      },
      TEST_LOG,
      chatResponseDependencies({
        createMessage: async request => {
          requests.push(request)
        },
      })
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual({
      parent: "spaces/room",
      requestBody: {
        text: "Threaded response",
        thread: { name: "spaces/room/threads/thread-1" },
      },
      messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    })
  })

  test("records a room-post 403 and delivers the response by DM without rethrowing", async () => {
    const requests: Array<
      Parameters<ChatResponseDependencies["createMessage"]>[0]
    > = []
    const failures: Array<
      Parameters<ChatResponseDependencies["recordFailure"]>[0]
    > = []
    let createAttempt = 0

    await expect(
      sendGoogleChatResponseWithDependencies(
        {
          spaceName: "spaces/room",
          threadName: "spaces/room/threads/thread-1",
          text: "Private answer",
          deliveryContext: {
            isSharedSpace: true,
            senderGoogleIdentity: "users/owner",
            userId: "owner@psd401.net",
            sessionId: "session-1",
          },
        },
        TEST_LOG,
        chatResponseDependencies({
          createMessage: async request => {
            requests.push(request)
            createAttempt += 1
            if (createAttempt === 1) {
              throw Object.assign(
                new Error(
                  "This organization's administrator restricts this Chat app from performing this action"
                ),
                { code: 403, response: { status: 403 } }
              )
            }
          },
          resolveDmSpace: async googleIdentity => {
            expect(googleIdentity).toBe("users/owner")
            return "spaces/owner-dm"
          },
          recordFailure: async params => {
            failures.push(params)
          },
        })
      )
    ).resolves.toBeUndefined()

    expect(requests).toHaveLength(2)
    expect(requests[1]?.parent).toBe("spaces/owner-dm")
    expect(requests[1]?.messageReplyOption).toBeUndefined()
    expect(requests[1]?.requestBody.thread).toBeUndefined()
    expect(requests[1]?.requestBody.text).toContain("Private answer")
    expect(requests[1]?.requestBody.text).toContain(
      "administrator currently restricts this Chat app"
    )
    expect(failures.map(failure => failure.errorClass)).toEqual([
      "ChatPostPermissionDenied",
    ])
  })
})

describe("Google Chat response fallback failures", () => {
  test("records a missing sender DM without retrying the room post", async () => {
    const requests: Array<
      Parameters<ChatResponseDependencies["createMessage"]>[0]
    > = []
    const failures: Array<
      Parameters<ChatResponseDependencies["recordFailure"]>[0]
    > = []

    await expect(
      sendGoogleChatResponseWithDependencies(
        {
          spaceName: "spaces/room",
          threadName: "spaces/room/threads/thread-1",
          text: "Private answer",
          deliveryContext: {
            isSharedSpace: true,
            senderGoogleIdentity: "users/owner",
            userId: "owner@psd401.net",
            sessionId: "session-1",
          },
        },
        TEST_LOG,
        chatResponseDependencies({
          createMessage: async request => {
            requests.push(request)
            throw Object.assign(new Error("room post denied"), { code: 403 })
          },
          resolveDmSpace: async () => null,
          recordFailure: async params => {
            failures.push(params)
          },
        })
      )
    ).resolves.toBeUndefined()

    expect(requests).toHaveLength(1)
    expect(failures.map(failure => failure.errorClass)).toEqual([
      "ChatPostPermissionDenied",
      "ChatDmFallbackFailed",
    ])
    expect(failures[1]?.context).toMatchObject({
      dmFallbackAttempted: true,
      dmFallbackOutcome: "dm-space-not-found",
    })
  })

  test("records a failed DM post without surfacing an unhandled rejection", async () => {
    const requests: Array<
      Parameters<ChatResponseDependencies["createMessage"]>[0]
    > = []
    const failures: Array<
      Parameters<ChatResponseDependencies["recordFailure"]>[0]
    > = []

    await expect(
      sendGoogleChatResponseWithDependencies(
        {
          spaceName: "spaces/room",
          threadName: "spaces/room/threads/thread-1",
          text: "Private answer",
          deliveryContext: {
            isSharedSpace: true,
            senderGoogleIdentity: "users/owner",
            userId: "owner@psd401.net",
            sessionId: "session-1",
          },
        },
        TEST_LOG,
        chatResponseDependencies({
          createMessage: async request => {
            requests.push(request)
            if (requests.length === 1) {
              throw Object.assign(new Error("room post denied"), { code: 403 })
            }
            throw new Error("DM post failed")
          },
          resolveDmSpace: async () => "spaces/owner-dm",
          recordFailure: async params => {
            failures.push(params)
          },
        })
      )
    ).resolves.toBeUndefined()

    expect(requests).toHaveLength(2)
    expect(requests[1]?.parent).toBe("spaces/owner-dm")
    expect(failures.map(failure => failure.errorClass)).toEqual([
      "ChatPostPermissionDenied",
      "ChatDmFallbackFailed",
    ])
    expect(failures[1]?.errorMessage).toBe("DM post failed")
    expect(failures[1]?.context).toMatchObject({
      dmFallbackAttempted: true,
      dmFallbackOutcome: "failed",
    })
  })
})

describe("AgentCore audience context", () => {
  test("adds shared-space audience to owner and cross-user payloads", () => {
    const roomHuman = ownerHuman({ spaceType: "ROOM" })
    const ownerContext = buildAgentInvocationContext(roomHuman, OWNER_USER)
    const crossUserContext = buildAgentInvocationContext(
      roomHuman,
      OWNER_USER,
      {
        email: "caller@psd401.net",
        displayName: "Caller",
      }
    )
    const ownerPayload: Record<string, unknown> = {}
    const crossUserPayload: Record<string, unknown> = {}

    addOptionalAgentContext(ownerPayload, ownerContext)
    addOptionalAgentContext(crossUserPayload, crossUserContext)

    expect(ownerPayload.audience).toBe("shared-space")
    expect(crossUserPayload.audience).toBe("shared-space")
    expect(crossUserPayload.invoked_by_email).toBe("caller@psd401.net")
  })

  test("omits audience from DM payloads", () => {
    const dmContext = buildAgentInvocationContext(ownerHuman(), OWNER_USER)
    const payload: Record<string, unknown> = {}

    addOptionalAgentContext(payload, dmContext)

    expect(dmContext.audience).toBeUndefined()
    expect(payload.audience).toBeUndefined()
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

  test("persists shared-space attachments before a busy main-job reply", async () => {
    const human = ownerHuman({
      spaceType: "ROOM",
      messageText: "Please use this file",
    })
    human.attachments.push({
      name: "notes.txt",
      mimeType: "text/plain",
      source: "chat-upload",
      attachmentResourceName: "spaces/owner-room/messages/one/attachments/one",
    })
    let fetchedAttachments: OwnerHuman["attachments"] | undefined
    let fetchedWorkspacePrefix = ""
    const responses: string[] = []

    const turn = await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies({
        fetchChatUploads: async (attachments, workspacePrefix) => {
          fetchedAttachments = attachments
          fetchedWorkspacePrefix = workspacePrefix
        },
        isJobLockActive: async () => true,
        waitForSessionLock: async () => {
          throw new Error("busy shared-space turns must not wait for a lock")
        },
        invokeAgentCore: async () => {
          throw new Error("busy shared-space turns must not invoke the agent")
        },
        sendGoogleChatResponse: async (_space, _thread, text) => {
          responses.push(text)
        },
      })
    )

    expect(turn).toBeNull()
    expect(fetchedAttachments).toBe(human.attachments)
    expect(fetchedWorkspacePrefix).toBe(OWNER_USER.workspacePrefix)
    expect(responses).toEqual([
      "I'm still working on your earlier task in the background — I'll post the result here when it's done.",
    ])
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
