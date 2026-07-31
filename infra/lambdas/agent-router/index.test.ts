import { describe, expect, test } from "bun:test"
import { agentRouterTestHelpers, createLogger } from "./index"
import {
  JOB_DEADLINE_S,
  JOB_INVOCATION_CONTEXT_TTL_S,
  shouldPromoteToJob,
} from "./job-promotion"

const {
  normalizeChatEvent,
  cardClickMessageText,
  parseAgentCoreResult,
  totalAgentTokens,
  tryAcquireSessionLock,
  invokeWithSessionLockLease,
  jobPromotionIdentity,
  promotedJobRunTaskCommand,
  runTaskFailureCertainty,
  promoteToJobWithDependencies,
  parseAsideInvocation,
  ownerSessionId,
  ownerConversationSessionId,
  ownerWorkspaceLockId,
  asideSessionId,
  invokeOwnerAgentWithDependencies,
  buildOwnerResponse,
  buildOwnerJobPromotionInput,
  handleNonMessageEvent,
  extractIncomingMessage,
  addOptionalAgentContext,
  invocationTtlOptions,
  buildAgentInvocationContext,
  sendGoogleChatResponseWithDependencies,
  deferWorkspaceTurn,
  workspaceDeferredRecordNeedsRetry,
  WorkspaceTurnDeferredError,
  isDuplicateMessage,
  parseDeferredChatDelivery,
  parseDeferredChatDeliveryRecord,
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
type JobPromotionInput = Parameters<
  typeof promoteToJobWithDependencies
>[0]
type JobPromotionDependencies = Parameters<
  typeof promoteToJobWithDependencies
>[2]

const TEST_LOG = createLogger({ requestId: "agent-router-index-test" })

function ownerHuman(options: {
  spaceType?: "DM" | "ROOM" | "TYPE_UNSPECIFIED"
  spaceName?: string
  threadName?: string
  messageText?: string
  slashCommandId?: string
  argumentText?: string
} = {}): OwnerHuman {
  const {
    spaceType = "DM",
    spaceName = "spaces/owner-dm",
    threadName = `${spaceName}/threads/one`,
    messageText = "What is the status?",
    slashCommandId,
    argumentText,
  } = options
  return {
    chatEvent: {
      type: "MESSAGE",
      eventTime: "2026-07-27T12:00:00Z",
      space: { name: spaceName, type: spaceType },
      message: {
        name: `${spaceName}/messages/one`,
        text: messageText,
        ...(argumentText !== undefined
          ? { argumentText }
          : {}),
        sender: {
          name: "users/owner",
          displayName: "Owner",
          email: "owner@psd401.net",
          type: "HUMAN",
        },
        ...(slashCommandId
          ? { slashCommand: { commandId: slashCommandId } }
          : {}),
        createTime: "2026-07-27T12:00:00Z",
      },
    },
    message: {
      name: `${spaceName}/messages/one`,
      text: messageText,
      ...(argumentText !== undefined
        ? { argumentText }
        : {}),
      sender: {
        name: "users/owner",
        displayName: "Owner",
        email: "owner@psd401.net",
        type: "HUMAN",
      },
      ...(slashCommandId
        ? { slashCommand: { commandId: slashCommandId } }
        : {}),
      createTime: "2026-07-27T12:00:00Z",
    },
    attachments: [],
    isSharedSpace: spaceType !== "DM",
    senderName: "users/owner",
    senderEmail: "owner@psd401.net",
    senderDisplayName: "Owner",
    messageText,
    spaceName,
    threadName,
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
  workspaceFinalizationConfirmed: true,
}

const JOB_PROMOTION_INPUT: JobPromotionInput = {
  promotionId: "spaces/owner-dm/messages/one",
  reason: "deadline",
  sessionId: "agent-runtime-owner-build",
  workspaceLockId: "agent-workspace-owner",
  conversationSessionId: "agent-chat-thread-one",
  userEmail: "owner@psd401.net",
  googleIdentity: "users/owner",
  displayName: "Owner",
  workspacePrefix: "owner-a1b2c3d4",
  spaceName: "spaces/owner-dm",
  threadName: "spaces/owner-dm/threads/one",
  isDM: true,
  originalPrompt: "Complete the long-running task",
}

function chatResponseDependencies(
  overrides: Partial<ChatResponseDependencies> = {}
): ChatResponseDependencies {
  return {
    createMessage: async () => {},
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
    renewSessionLock: async () => true,
    releaseSessionLock: async () => {},
    renewalScheduler: {
      start: () => ({}),
      stop: () => {},
    },
    invokeAgentCore: async () => AGENT_RESULT,
    sendGoogleChatResponse: async () => {},
    ...overrides,
  }
}

function promotionDependencies(
  overrides: Partial<JobPromotionDependencies> = {}
): JobPromotionDependencies {
  return {
    getConfig: () => ({
      clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/dev",
      taskDefArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/job:1",
      subnets: ["subnet-123"],
      securityGroup: "sg-123",
      containerName: "job-runner",
    }),
    getRuntimeId: () => "agent-runtime-dev",
    acquireLock: async (_workspaceLockId, requestedLockToken) =>
      requestedLockToken,
    releaseLock: async () => {},
    runJob: async () =>
      "arn:aws:ecs:us-east-1:123456789012:task/task-123",
    sendResponse: async () => "delivered",
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

  test("keeps an added-to-space welcome failure in the originating room", async () => {
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
          space: { name: "spaces/room", type: "ROOM" },
        },
      },
    })
    let deliveryContext: Record<string, unknown> | undefined

    const handled = await handleNonMessageEvent(
      event,
      TEST_LOG,
      async (_space, _thread, _text, _log, context) => {
        deliveryContext = context
        return "failed"
      }
    )

    expect(handled).toBe(true)
    expect(deliveryContext).toMatchObject({
      isSharedSpace: true,
      userId: "user@psd401.net",
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
        workspace_finalization_confirmed: true,
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
    expect(result.workspaceFinalizationConfirmed).toBe(true)
    expect(totalAgentTokens(result)).toBe(37)
  })

  test("uses compatibility defaults for older harness responses", () => {
    const result = parseAgentCoreResult({})

    expect(result.response).toBe("No response from agent.")
    expect(result.model).toBe("unknown")
    expect(result.messages).toEqual([])
    expect(result.toolCalls).toEqual([])
    expect(result.failed).toBe(false)
    expect(result.workspaceFinalizationConfirmed).toBe(false)
  })

  test("does not treat a legacy result string as workspace finalization proof", () => {
    const result = parseAgentCoreResult({ result: "legacy answer" })

    expect(result.response).toBe("legacy answer")
    expect(result.workspaceFinalizationConfirmed).toBe(false)
  })
})

describe("Google Chat response delivery", () => {
  test("requires delivery to the exact source thread", async () => {
    const requests: Array<
      Parameters<ChatResponseDependencies["createMessage"]>[0]
    > = []

    const outcome = await sendGoogleChatResponseWithDependencies(
      {
        spaceName: "spaces/room",
        threadName: "spaces/room/threads/thread-1",
        text: "Threaded response",
        deliveryContext: {
          deliveryRequestId:
            "11111111-2222-4333-8444-555555555555",
        },
      },
      TEST_LOG,
      chatResponseDependencies({
        createMessage: async request => {
          requests.push(request)
        },
      })
    )

    expect(requests).toHaveLength(1)
    expect(outcome).toBe("delivered")
    expect(requests[0]).toEqual({
      parent: "spaces/room",
      requestBody: {
        text: "Threaded response",
        thread: { name: "spaces/room/threads/thread-1" },
      },
      requestId: "11111111-2222-4333-8444-555555555555",
      messageReplyOption: "REPLY_MESSAGE_OR_FAIL",
    })
  })

  test("records a completed room-post 403 for exact-destination retry", async () => {
    const requests: Array<
      Parameters<ChatResponseDependencies["createMessage"]>[0]
    > = []
    const failures: Array<
      Parameters<ChatResponseDependencies["recordFailure"]>[0]
    > = []
    const outcome = await sendGoogleChatResponseWithDependencies(
      {
        spaceName: "spaces/room",
        threadName: "spaces/room/threads/thread-1",
        text: "Completed answer",
        deliveryContext: {
          isSharedSpace: true,
          deliveryRequestId:
            "11111111-2222-4333-8444-555555555555",
          userId: "owner@psd401.net",
          sessionId: "session-1",
        },
      },
      TEST_LOG,
      chatResponseDependencies({
        createMessage: async request => {
          requests.push(request)
          throw Object.assign(new Error("room post denied"), {
            code: 403,
          })
        },
        recordFailure: async params => {
          failures.push(params)
        },
      })
    )

    expect(outcome).toBe("failed")
    expect(requests).toEqual([
      {
        parent: "spaces/room",
        requestBody: {
          text: "Completed answer",
          thread: { name: "spaces/room/threads/thread-1" },
        },
        requestId: "11111111-2222-4333-8444-555555555555",
        messageReplyOption: "REPLY_MESSAGE_OR_FAIL",
      },
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      severity: "error",
      errorClass: "ChatPostPermissionDenied",
      context: {
        phase: "google_chat_response",
        spaceName: "spaces/room",
        threadName: "spaces/room/threads/thread-1",
        retryInPlace: true,
        channelRebound: false,
      },
    })
  })

  test("keeps lifecycle-notice failures in the source channel", async () => {
    const requests: Array<
      Parameters<ChatResponseDependencies["createMessage"]>[0]
    > = []
    const failures: Array<
      Parameters<ChatResponseDependencies["recordFailure"]>[0]
    > = []
    const outcome = await sendGoogleChatResponseWithDependencies(
      {
        spaceName: "spaces/room",
        threadName: "spaces/room/threads/thread-1",
        text: "Welcome",
        deliveryContext: {
          isSharedSpace: true,
          userId: "owner@psd401.net",
        },
      },
      TEST_LOG,
      chatResponseDependencies({
        createMessage: async request => {
          requests.push(request)
          throw Object.assign(new Error("permission denied"), { code: 403 })
        },
        recordFailure: async params => {
          failures.push(params)
        },
      })
    )

    expect(outcome).toBe("failed")
    expect(requests).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      severity: "warn",
      alert: false,
      errorClass: "ChatPostPermissionDenied",
      context: {
        phase: "google_chat_lifecycle_notice",
        spaceName: "spaces/room",
        threadName: "spaces/room/threads/thread-1",
        retryInPlace: false,
        channelRebound: false,
      },
    })
  })
})

describe("durable Chat delivery envelope parsing", () => {
  test("strictly parses a bounded Chat delivery outbox envelope", () => {
    const valid = JSON.stringify({
      kind: "agent-chat-delivery-v1",
      spaceName: "spaces/room",
      threadName: "spaces/room/threads/one",
      text: "Completed answer",
      deliveryContext: {
        isSharedSpace: true,
        durableDelivery: false,
        deliveryRequestId:
          "11111111-2222-4333-8444-555555555555",
        userId: "owner@psd401.net",
        sessionId: "agent-chat-thread-one",
      },
    })

    expect(parseDeferredChatDelivery(valid)).toEqual(
      JSON.parse(valid)
    )
    expect(
      parseDeferredChatDelivery(
        JSON.stringify({
          ...JSON.parse(valid),
          unexpected: true,
        })
      )
    ).toBeNull()
    expect(
      parseDeferredChatDelivery(
        JSON.stringify({
          ...JSON.parse(valid),
          deliveryContext: {
            ...JSON.parse(valid).deliveryContext,
            durableDelivery: true,
          },
        })
      )
    ).toBeNull()
    expect(
      parseDeferredChatDelivery("x".repeat(33 * 1024))
    ).toBeNull()

    const legacy = JSON.parse(valid) as Record<string, unknown>
    const legacyContext = legacy.deliveryContext as Record<string, unknown>
    legacyContext.allowDmFallback = true
    legacyContext.senderGoogleIdentity = "users/owner"
    expect(parseDeferredChatDelivery(JSON.stringify(legacy))).toEqual(
      JSON.parse(valid)
    )
  })

  test("recognizes a malformed reserved delivery envelope for SQS redrive", () => {
    const malformedEnvelope = JSON.stringify({
      kind: "agent-chat-delivery-v1",
      spaceName: "spaces/room",
      text: "Completed answer",
      deliveryContext: {
        durableDelivery: true,
        deliveryRequestId:
          "11111111-2222-4333-8444-555555555555",
      },
    })

    expect(parseDeferredChatDelivery(malformedEnvelope)).toBeNull()
    expect(
      () => parseDeferredChatDeliveryRecord(malformedEnvelope)
    ).toThrow("Malformed durable Chat delivery envelope")
    expect(
      parseDeferredChatDeliveryRecord(
        JSON.stringify({
          message: {
            name: "spaces/room/messages/one",
            text: "ordinary Chat event",
          },
        })
      )
    ).toBeNull()
  })
})

describe("workspace turn durable deferral", () => {
  test("reclaims an expired dedup row without waiting for Dynamo TTL deletion", async () => {
    let commandInput: Record<string, unknown> | undefined
    const duplicate = await isDuplicateMessage(
      "spaces/room/messages/expired",
      TEST_LOG,
      {
        tableName: "message-dedup-test",
        send: async command => {
          commandInput = command.input as Record<string, unknown>
        },
      }
    )

    expect(duplicate).toBe(false)
    expect(commandInput).toMatchObject({
      TableName: "message-dedup-test",
      ConditionExpression:
        "attribute_not_exists(messageName) OR expiresAt < :now",
    })
    const values = commandInput?.ExpressionAttributeValues as Record<
      string,
      unknown
    >
    expect(values[":now"]).toBeNumber()
  })

  test("releases the dedup claim and requeues a bounded copy in one minute", async () => {
    const previousQueueUrl = process.env.ROUTER_QUEUE_URL
    process.env.ROUTER_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123456789012/router"
    const releasedClaims: Array<string | undefined> = []
    const enqueued: Array<Record<string, unknown>> = []
    try {
      const requeued = await deferWorkspaceTurn(
        {
          body: "{\"message\":{\"data\":\"original\"}}",
          receiptHandle: "receipt-1",
          attributes: { ApproximateReceiveCount: "2" },
          messageAttributes: {
            TraceId: {
              dataType: "String",
              stringValue: "trace-123",
            },
          },
        } as Parameters<typeof deferWorkspaceTurn>[0],
        new WorkspaceTurnDeferredError(
          "spaces/room/messages/two",
          "workspace-contended"
        ),
        TEST_LOG,
        {
          releaseClaim: async messageName => {
            releasedClaims.push(messageName)
            return true
          },
          enqueue: async input => {
            enqueued.push(input)
          },
          nowSeconds: () => 1_700_000_000,
        }
      )
      expect(requeued).toBe(true)
    } finally {
      if (previousQueueUrl === undefined) {
        delete process.env.ROUTER_QUEUE_URL
      } else {
        process.env.ROUTER_QUEUE_URL = previousQueueUrl
      }
    }

    expect(releasedClaims).toEqual(["spaces/room/messages/two"])
    expect(enqueued).toEqual([
      {
        QueueUrl:
          "https://sqs.us-east-1.amazonaws.com/123456789012/router",
        MessageBody: "{\"message\":{\"data\":\"original\"}}",
        DelaySeconds: 60,
        MessageAttributes: {
          TraceId: {
            DataType: "String",
            StringValue: "trace-123",
          },
          PsdWorkspaceDeferV1: {
            DataType: "String",
            StringValue:
              "{\"firstDeferredAt\":1700000000,\"attempt\":1}",
          },
        },
      },
    ])
  })

  test("keeps default visibility when the dedup claim cannot be released", async () => {
    const previousQueueUrl = process.env.ROUTER_QUEUE_URL
    process.env.ROUTER_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123456789012/router"
    const enqueued: Array<Record<string, unknown>> = []
    let requeued: boolean
    try {
      requeued = await deferWorkspaceTurn(
        { body: "original", receiptHandle: "receipt-2" } as Parameters<
          typeof deferWorkspaceTurn
        >[0],
        new WorkspaceTurnDeferredError(
          "spaces/room/messages/three",
          "background-job-active"
        ),
        TEST_LOG,
        {
          releaseClaim: async () => false,
          enqueue: async input => {
            enqueued.push(input)
          },
          nowSeconds: () => 1_700_000_000,
        }
      )
    } finally {
      if (previousQueueUrl === undefined) {
        delete process.env.ROUTER_QUEUE_URL
      } else {
        process.env.ROUTER_QUEUE_URL = previousQueueUrl
      }
    }

    expect(requeued).toBe(false)
    expect(enqueued).toHaveLength(0)
  })
})

describe("workspace turn bounded deferral settlement", () => {
  test("stops requeueing at the three-hour bound so SQS can DLQ the record", async () => {
    const previousQueueUrl = process.env.ROUTER_QUEUE_URL
    process.env.ROUTER_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123456789012/router"
    const releasedClaims: Array<string | undefined> = []
    const enqueued: Array<Record<string, unknown>> = []
    const nowSeconds = 1_700_010_800
    let requeued: boolean
    try {
      requeued = await deferWorkspaceTurn(
        {
          body: "original",
          messageAttributes: {
            PsdWorkspaceDeferV1: {
              dataType: "String",
              stringValue: JSON.stringify({
                firstDeferredAt: nowSeconds - 10_800,
                attempt: 179,
              }),
            },
          },
        } as Parameters<typeof deferWorkspaceTurn>[0],
        new WorkspaceTurnDeferredError(
          "spaces/room/messages/bounded",
          "background-job-active"
        ),
        TEST_LOG,
        {
          releaseClaim: async messageName => {
            releasedClaims.push(messageName)
            return true
          },
          enqueue: async input => {
            enqueued.push(input)
          },
          nowSeconds: () => nowSeconds,
        }
      )
    } finally {
      if (previousQueueUrl === undefined) {
        delete process.env.ROUTER_QUEUE_URL
      } else {
        process.env.ROUTER_QUEUE_URL = previousQueueUrl
      }
    }

    expect(requeued).toBe(false)
    expect(releasedClaims).toHaveLength(0)
    expect(enqueued).toHaveLength(0)
  })

  test("acks the original only after a workspace retry copy is confirmed", async () => {
    const record = {
      messageId: "source-message",
      body: "original",
    } as Parameters<typeof workspaceDeferredRecordNeedsRetry>[0]
    const error = new WorkspaceTurnDeferredError(
      "spaces/room/messages/ack",
      "workspace-contended"
    )

    await expect(
      workspaceDeferredRecordNeedsRetry(
        record,
        error,
        TEST_LOG,
        async () => true
      )
    ).resolves.toBe(false)
    await expect(
      workspaceDeferredRecordNeedsRetry(
        record,
        error,
        TEST_LOG,
        async () => false
      )
    ).resolves.toBe(true)
  })

  test("keeps the original failed when the delayed send is uncertain", async () => {
    const retryOriginal = await workspaceDeferredRecordNeedsRetry(
      {
        messageId: "source-message",
        body: "original",
      } as Parameters<typeof workspaceDeferredRecordNeedsRetry>[0],
      new WorkspaceTurnDeferredError(
        "spaces/room/messages/uncertain",
        "workspace-contended"
      ),
      TEST_LOG,
      async () => {
        throw new Error("send response lost")
      }
    )

    expect(retryOriginal).toBe(true)
  })
})

describe("AgentCore audience context", () => {
  test("treats TYPE_UNSPECIFIED as shared at ingress", () => {
    const incoming = extractIncomingMessage(
      ownerHuman({ spaceType: "TYPE_UNSPECIFIED" }).chatEvent,
      TEST_LOG
    )

    expect(incoming?.isSharedSpace).toBe(true)
  })

  test("uses the current sender name for owner turns and the target name for cross-user turns", () => {
    const human = ownerHuman()
    human.senderDisplayName = "Current Owner Name"
    const staleOwner = {
      ...OWNER_USER,
      displayName: "Persisted Owner Name",
    }

    const ownerContext = buildAgentInvocationContext(human, staleOwner)
    const crossUserContext = buildAgentInvocationContext(
      human,
      staleOwner,
      {
        email: "caller@psd401.net",
        displayName: "Caller",
      }
    )

    expect(ownerContext.displayName).toBe("Current Owner Name")
    expect(crossUserContext.displayName).toBe("Persisted Owner Name")
  })

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

  test("forwards the logical conversation id independently of workspace affinity", () => {
    const human = ownerHuman()
    const conversationSessionId = ownerConversationSessionId(
      human,
      OWNER_USER
    )
    const context = buildAgentInvocationContext(
      human,
      OWNER_USER,
      undefined,
      conversationSessionId
    )
    const payload: Record<string, unknown> = {}

    addOptionalAgentContext(payload, context)

    expect(payload.conversation_session_id).toBe(conversationSessionId)
    expect(conversationSessionId).not.toBe(
      ownerSessionId(human, OWNER_USER)
    )
  })
})

describe("Google Chat workspace and conversation identity", () => {
  test("keeps one owner workspace lock across spaces and deployments", () => {
    const previousBuildTag = process.env.AGENT_BUILD_TAG
    const firstHuman = ownerHuman({
      spaceName: "spaces/one",
      threadName: "spaces/one/threads/one",
    })
    const secondHuman = ownerHuman({
      spaceType: "ROOM",
      spaceName: "spaces/two",
      threadName: "spaces/two/threads/two",
    })
    try {
      process.env.AGENT_BUILD_TAG = "first-deploy"
      const firstLockId = ownerWorkspaceLockId(OWNER_USER)
      expect(ownerWorkspaceLockId(OWNER_USER)).toBe(firstLockId)
      expect(ownerSessionId(firstHuman, OWNER_USER)).toBe(
        ownerSessionId(secondHuman, OWNER_USER)
      )

      process.env.AGENT_BUILD_TAG = "second-deploy"
      expect(ownerWorkspaceLockId(OWNER_USER)).toBe(firstLockId)
      expect(ownerWorkspaceLockId({
        ...OWNER_USER,
        workspacePrefix: "another-owner-deadbeef",
      })).not.toBe(firstLockId)
    } finally {
      if (previousBuildTag === undefined) {
        delete process.env.AGENT_BUILD_TAG
      } else {
        process.env.AGENT_BUILD_TAG = previousBuildTag
      }
    }
  })

  test("uses one owner runtime across spaces and threads", () => {
    const dmThreadOne = ownerHuman({
      spaceName: "spaces/dm",
      threadName: "spaces/dm/threads/one",
    })
    const dmThreadTwo = ownerHuman({
      spaceName: "spaces/dm",
      threadName: "spaces/dm/threads/two",
    })
    const roomThread = ownerHuman({
      spaceType: "ROOM",
      spaceName: "spaces/room",
      threadName: "spaces/room/threads/one",
    })

    const runtimeId = ownerSessionId(dmThreadOne, OWNER_USER)
    expect(ownerSessionId(dmThreadTwo, OWNER_USER)).toBe(runtimeId)
    expect(ownerSessionId(roomThread, OWNER_USER)).toBe(runtimeId)
  })

  test("isolates each space/thread while preserving same-thread continuity", () => {
    const first = ownerHuman({
      spaceName: "spaces/dm",
      threadName: "spaces/dm/threads/one",
    })
    const sameThread = ownerHuman({
      spaceName: "spaces/dm",
      threadName: "spaces/dm/threads/one",
      messageText: "Follow up",
    })
    const otherThread = ownerHuman({
      spaceName: "spaces/dm",
      threadName: "spaces/dm/threads/two",
    })
    const otherSpace = ownerHuman({
      spaceType: "ROOM",
      spaceName: "spaces/room",
      threadName: "spaces/room/threads/one",
    })

    const firstId = ownerConversationSessionId(first, OWNER_USER)
    expect(ownerConversationSessionId(sameThread, OWNER_USER)).toBe(firstId)
    expect(ownerConversationSessionId(otherThread, OWNER_USER)).not.toBe(
      firstId
    )
    expect(ownerConversationSessionId(otherSpace, OWNER_USER)).not.toBe(
      firstId
    )
  })

  test("rotates runtime affinity on deploy without abandoning thread history", () => {
    const previousBuildTag = process.env.AGENT_BUILD_TAG
    const human = ownerHuman()
    try {
      process.env.AGENT_BUILD_TAG = "image-one-config"
      const firstRuntimeId = ownerSessionId(human, OWNER_USER)
      const firstConversationId = ownerConversationSessionId(
        human,
        OWNER_USER
      )

      process.env.AGENT_BUILD_TAG = "image-two-config"
      expect(ownerSessionId(human, OWNER_USER)).not.toBe(firstRuntimeId)
      expect(ownerConversationSessionId(human, OWNER_USER)).toBe(
        firstConversationId
      )
    } finally {
      if (previousBuildTag === undefined) {
        delete process.env.AGENT_BUILD_TAG
      } else {
        process.env.AGENT_BUILD_TAG = previousBuildTag
      }
    }
  })

  test("keeps owner runtime ids inside AgentCore's session-id contract", () => {
    const previousBuildTag = process.env.AGENT_BUILD_TAG
    process.env.AGENT_BUILD_TAG = `tag:/invalid-${"x".repeat(500)}`
    try {
      const runtimeId = ownerSessionId(
        ownerHuman(),
        { ...OWNER_USER, workspacePrefix: "w".repeat(500) }
      )
      expect(runtimeId.length).toBeGreaterThanOrEqual(33)
      expect(runtimeId.length).toBeLessThanOrEqual(100)
      expect(runtimeId).toHaveLength(98)
      expect(runtimeId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    } finally {
      if (previousBuildTag === undefined) {
        delete process.env.AGENT_BUILD_TAG
      } else {
        process.env.AGENT_BUILD_TAG = previousBuildTag
      }
    }
  })

  test("keeps job broker authority alive after the two-hour work deadline", () => {
    expect(invocationTtlOptions(JOB_DEADLINE_S)).toEqual({
      ttlSeconds: JOB_INVOCATION_CONTEXT_TTL_S,
    })
    expect(invocationTtlOptions(550)).toEqual({ ttlSeconds: 550 })
    expect(invocationTtlOptions(undefined)).toEqual({})
  })
})

describe("Google Chat invocation identity wiring", () => {
  test("locks and invokes the owner runtime but passes the thread transcript id", async () => {
    const human = ownerHuman({
      spaceType: "ROOM",
      spaceName: "spaces/room",
      threadName: "spaces/room/threads/thread-1",
    })
    const expectedRuntimeId = ownerSessionId(human, OWNER_USER)
    const expectedWorkspaceLockId = ownerWorkspaceLockId(OWNER_USER)
    const expectedConversationId = ownerConversationSessionId(
      human,
      OWNER_USER
    )
    let lockedSessionId = ""
    let invokedSessionId = ""
    let invokedConversationId = ""

    const turn = await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies({
        tryAcquireSessionLock: async sessionId => {
          lockedSessionId = sessionId
          return "owner-lock"
        },
        invokeAgentCore: async (
          _message,
          _userId,
          sessionId,
          _log,
          context
        ) => {
          invokedSessionId = sessionId
          invokedConversationId = context?.conversationSessionId ?? ""
          return AGENT_RESULT
        },
      })
    )

    expect(lockedSessionId).toBe(expectedWorkspaceLockId)
    expect(invokedSessionId).toBe(expectedRuntimeId)
    expect(invokedConversationId).toBe(expectedConversationId)
    expect(turn?.sessionId).toBe(expectedRuntimeId)
    expect(turn?.workspaceLockId).toBe(expectedWorkspaceLockId)
    expect(turn?.conversationSessionId).toBe(expectedConversationId)
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

describe("workspace lock lease lifecycle", () => {
  test("acquires a workspace lease with at least thirty minutes of headroom", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    let expiresAt = 0

    const acquired = await tryAcquireSessionLock(
      ownerWorkspaceLockId(OWNER_USER),
      TEST_LOG,
      "turn",
      {
        tableName: "agent-session-locks-dev",
        send: async command => {
          const item = command.input.Item as
            | Record<string, unknown>
            | undefined
          expiresAt =
            typeof item?.expiresAt === "number" ? item.expiresAt : 0
        },
      }
    )

    expect(acquired).not.toBeNull()
    expect(expiresAt - nowSeconds).toBeGreaterThanOrEqual(30 * 60)
  })

  test("renews every five minutes and releases after a confirmed final push", async () => {
    const intervals: number[] = []
    const stoppedTimers: unknown[] = []
    const renewed: string[] = []
    const released: string[] = []

    const result = await invokeWithSessionLockLease(
      "workspace-lock",
      "lock-token",
      TEST_LOG,
      async () => AGENT_RESULT,
      {
        renewSessionLock: async sessionId => {
          renewed.push(sessionId)
          return true
        },
        releaseSessionLock: async sessionId => {
          released.push(sessionId)
        },
        scheduler: {
          start: (callback, intervalMs) => {
            intervals.push(intervalMs)
            callback()
            return "renewal-timer"
          },
          stop: timer => {
            stoppedTimers.push(timer)
          },
        },
      }
    )

    expect(result).toBe(AGENT_RESULT)
    expect(intervals).toEqual([5 * 60 * 1000])
    expect(renewed).toEqual(["workspace-lock"])
    expect(stoppedTimers).toEqual(["renewal-timer"])
    expect(released).toEqual(["workspace-lock"])
  })

  test("retains the workspace lease when the terminal result is missing", async () => {
    const released: string[] = []

    await invokeWithSessionLockLease(
      "workspace-lock",
      "lock-token",
      TEST_LOG,
      async () => ({
        ...AGENT_RESULT,
        workspaceFinalizationConfirmed: false,
      }),
      {
        renewSessionLock: async () => true,
        releaseSessionLock: async sessionId => {
          released.push(sessionId)
        },
        scheduler: {
          start: () => "renewal-timer",
          stop: () => {},
        },
      }
    )

    expect(released).toEqual([])
  })

  test("retains the workspace lease when the transport disconnects", async () => {
    const released: string[] = []

    await expect(
      invokeWithSessionLockLease(
        "workspace-lock",
        "lock-token",
        TEST_LOG,
        async () => {
          throw new Error("socket disconnected")
        },
        {
          renewSessionLock: async () => true,
          releaseSessionLock: async sessionId => {
            released.push(sessionId)
          },
          scheduler: {
            start: () => "renewal-timer",
            stop: () => {},
          },
        }
      )
    ).rejects.toThrow("socket disconnected")

    expect(released).toEqual([])
  })
})

describe("owner-DM aside routing and locks", () => {
  test("fails closed when a configured lock table is unavailable", async () => {
    const acquired = await tryAcquireSessionLock(
      ownerWorkspaceLockId(OWNER_USER),
      TEST_LOG,
      "turn",
      {
        tableName: "agent-session-locks-dev",
        send: async () => {
          throw new Error("DynamoDB unavailable")
        },
      }
    )

    expect(acquired).toBeNull()
  })

  test("/btw keeps a separate transcript under the owner workspace lock", async () => {
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
        isJobLockActive: async () => false,
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
    const expectedRuntimeId = ownerSessionId(human, OWNER_USER)
    const expectedWorkspaceLockId = ownerWorkspaceLockId(OWNER_USER)
    expect(turn?.prompt).toBe("What is next?")
    expect(turn?.sessionId).toBe(expectedRuntimeId)
    expect(turn?.conversationSessionId).toBe(expectedAsideId)
    expect(turn?.workspaceLockId).toBe(expectedWorkspaceLockId)
    expect(turn?.isAside).toBe(true)
    expect(acquired).toEqual([expectedWorkspaceLockId])
    expect(invoked).toEqual([expectedRuntimeId])
    expect(released).toEqual([expectedWorkspaceLockId])
  })

  test("defers a turn durably while a background job owns the workspace", async () => {
    const human = ownerHuman({ messageText: "What time is the meeting?" })
    const responses: string[] = []
    let lockAttempted = false
    await expect(
      invokeOwnerAgentWithDependencies(
        human,
        OWNER_USER,
        human.messageText,
        TEST_LOG,
        ownerDependencies({
          isJobLockActive: async sessionId => {
            expect(sessionId).toBe(ownerWorkspaceLockId(OWNER_USER))
            return true
          },
          tryAcquireSessionLock: async () => {
            lockAttempted = true
            return "unexpected"
          },
          sendGoogleChatResponse: async (_space, _thread, text) => {
            responses.push(text)
          },
        })
      )
    ).rejects.toThrow("background job")
    expect(lockAttempted).toBe(false)
    expect(responses).toHaveLength(0)
  })

  test("plain messages acquire the stable workspace lock without waiting", async () => {
    const human = ownerHuman({ messageText: "Continue the main conversation" })
    let acquiredSessionId = ""
    const turn = await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies({
        isJobLockActive: async () => false,
        tryAcquireSessionLock: async sessionId => {
          acquiredSessionId = sessionId
          return "main-lock"
        },
      })
    )

    const mainId = ownerSessionId(human, OWNER_USER)
    expect(acquiredSessionId).toBe(ownerWorkspaceLockId(OWNER_USER))
    expect(turn?.sessionId).toBe(mainId)
    expect(turn?.conversationSessionId).toBe(
      ownerConversationSessionId(human, OWNER_USER)
    )
    expect(turn?.isAside).toBe(false)
  })
})

describe("owner workspace attachment locking and contention", () => {
  test("transfers attachments only while holding the workspace lock", async () => {
    const human = ownerHuman({ messageText: "Use the attachment" })
    human.attachments.push({
      name: "notes.txt",
      mimeType: "text/plain",
      source: "chat-upload",
      attachmentResourceName:
        "spaces/owner-dm/messages/one/attachments/one",
    })
    const events: string[] = []

    await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies({
        tryAcquireSessionLock: async () => {
          events.push("lock")
          return "owner-lock"
        },
        fetchChatUploads: async (
          _attachments,
          _workspacePrefix,
          _log,
          messageName,
          messageCreatedAt
        ) => {
          expect(messageName).toBe(human.message.name)
          expect(messageCreatedAt).toBe(human.message.createTime)
          events.push("attachments")
        },
        invokeAgentCore: async () => {
          events.push("invoke")
          return AGENT_RESULT
        },
        releaseSessionLock: async () => {
          events.push("release")
        },
      })
    )

    expect(events).toEqual(["lock", "attachments", "invoke", "release"])
  })

  test("defers lock contention without consuming the Chat turn", async () => {
    const human = ownerHuman({
      spaceType: "ROOM",
      spaceName: "spaces/room",
      threadName: "spaces/room/threads/contention",
    })
    await expect(
      invokeOwnerAgentWithDependencies(
        human,
        OWNER_USER,
        human.messageText,
        TEST_LOG,
        ownerDependencies({
          isJobLockActive: async () => false,
          tryAcquireSessionLock: async () => null,
        })
      )
    ).rejects.toThrow("another turn")
  })
})

describe("owner-DM aside fallback, scope, and responses", () => {
  test("queues an aside when the owner workspace is busy", async () => {
    const human = ownerHuman({ messageText: "Quick question" })
    const responses: string[] = []
    let invoked = false
    await expect(
      invokeOwnerAgentWithDependencies(
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
    ).rejects.toThrow("background job")
    expect(invoked).toBe(false)
    expect(responses).toHaveLength(0)
  })

  test("keeps /btw text on the main route outside owner DMs", async () => {
    const human = ownerHuman({
      spaceType: "ROOM",
      messageText: "/btw This must not use the sidecar",
    })
    let acquiredSessionId = ""
    let invokedPrompt = ""
    const turn = await invokeOwnerAgentWithDependencies(
      human,
      OWNER_USER,
      human.messageText,
      TEST_LOG,
      ownerDependencies({
        tryAcquireSessionLock: async sessionId => {
          acquiredSessionId = sessionId
          return "main-lock"
        },
        invokeAgentCore: async (message, _userId, _sessionId) => {
          invokedPrompt = message
          return AGENT_RESULT
        },
      })
    )

    const mainId = ownerSessionId(human, OWNER_USER)
    expect(acquiredSessionId).toBe(ownerWorkspaceLockId(OWNER_USER))
    expect(turn?.sessionId).toBe(mainId)
    expect(turn?.conversationSessionId).toBe(
      ownerConversationSessionId(human, OWNER_USER)
    )
    expect(turn?.isAside).toBe(false)
    expect(invokedPrompt).toBe("/btw This must not use the sidecar")
  })

  test("defers attachment transfer until the workspace lock is held", async () => {
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

    await expect(
      invokeOwnerAgentWithDependencies(
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
          invokeAgentCore: async () => {
            throw new Error("busy shared-space turns must not invoke the agent")
          },
          sendGoogleChatResponse: async (_space, _thread, text) => {
            responses.push(text)
          },
        })
      )
    ).rejects.toThrow("background job")
    expect(fetchedAttachments).toBeUndefined()
    expect(fetchedWorkspacePrefix).toBe("")
    expect(responses).toEqual([])
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
      promotableTurn,
      "deadline"
    )
    expect(promotion.promotionId).toBe(human.message.name)
    expect(promotion.sessionId).toBe(ownerSessionId(human, OWNER_USER))
    expect(promotion.conversationSessionId).toBe(
      asideSessionId(human, OWNER_USER)
    )
    expect(promotion.acknowledgementPrefix).toBe("[aside] ")
    expect(promotion.responsePrefix).toBe("[aside] ")
    expect(
      buildOwnerResponse(human, turn!.result, turn!.responsePrefix)
    ).toStartWith("[aside] ")
  })
})

describe("background promotion launch identity", () => {
  test("derives a stable ECS client token and matching payload lock token", () => {
    const first = jobPromotionIdentity(JOB_PROMOTION_INPUT)
    const retry = jobPromotionIdentity({ ...JOB_PROMOTION_INPUT })
    const otherMessage = jobPromotionIdentity({
      ...JOB_PROMOTION_INPUT,
      promotionId: "spaces/owner-dm/messages/two",
    })

    expect(first).toEqual(retry)
    expect(first).not.toEqual(otherMessage)
    expect(first.clientToken).toHaveLength(64)
    expect(first.clientToken).toMatch(/^[\x21-\x7E]+$/)
    expect(first.lockToken).toStartWith("job-")

    const command = promotedJobRunTaskCommand(
      promotionDependencies().getConfig()!,
      '{"job":"payload"}',
      first.clientToken
    )
    expect(command.input.clientToken).toBe(first.clientToken)
  })

  test("re-enters the same workspace lock token on a delivery retry", async () => {
    const identity = jobPromotionIdentity(JOB_PROMOTION_INPUT)
    let commandInput: Record<string, unknown> | undefined

    const acquired = await tryAcquireSessionLock(
      JOB_PROMOTION_INPUT.workspaceLockId,
      TEST_LOG,
      "job",
      {
        tableName: "agent-session-locks-dev",
        send: async command => {
          commandInput = command.input as Record<string, unknown>
        },
      },
      identity.lockToken
    )

    expect(acquired).toBe(identity.lockToken)
    expect(commandInput?.ConditionExpression).toContain(
      "OR lockToken = :tok"
    )
    expect(commandInput?.ExpressionAttributeValues).toMatchObject({
      ":tok": identity.lockToken,
    })
  })

  test("classifies explicit service rejection separately from ambiguity", () => {
    expect(
      runTaskFailureCertainty(
        Object.assign(new Error("invalid task"), {
          name: "ClientException",
          $metadata: { httpStatusCode: 400 },
        })
      )
    ).toBe("definite")
    expect(
      runTaskFailureCertainty(
        Object.assign(new Error("socket timed out"), {
          name: "TimeoutError",
        })
      )
    ).toBe("ambiguous")
    expect(
      runTaskFailureCertainty({
        name: "ServerException",
        $metadata: { httpStatusCode: 500 },
      })
    ).toBe("ambiguous")
    expect(
      runTaskFailureCertainty({
        name: "ThrottlingException",
        $metadata: { httpStatusCode: 429 },
      })
    ).toBe("definite")
    expect(
      runTaskFailureCertainty({ name: "ThrottlingException" })
    ).toBe("ambiguous")
  })
})

describe("background promotion ambiguous launch safety", () => {
  test("retains the owner lock when RunTask transport completion is uncertain", async () => {
    const released: string[] = []
    const requestedTokens: string[] = []
    const clientTokens: string[] = []
    const acknowledgements: string[] = []

    const promoted = await promoteToJobWithDependencies(
      JOB_PROMOTION_INPUT,
      TEST_LOG,
      promotionDependencies({
        acquireLock: async (_workspaceLockId, requestedLockToken) => {
          requestedTokens.push(requestedLockToken)
          return requestedLockToken
        },
        releaseLock: async workspaceLockId => {
          released.push(workspaceLockId)
        },
        runJob: async (_config, _payload, clientToken) => {
          clientTokens.push(clientToken)
          throw Object.assign(new Error("socket disconnected"), {
            name: "TimeoutError",
          })
        },
        sendResponse: async (_space, _thread, text) => {
          acknowledgements.push(text)
          return "delivered"
        },
      })
    )

    const identity = jobPromotionIdentity(JOB_PROMOTION_INPUT)
    expect(promoted).toBe(true)
    expect(requestedTokens).toEqual([identity.lockToken])
    expect(clientTokens).toEqual([
      identity.clientToken,
      identity.clientToken,
    ])
    expect(released).toEqual([])
    expect(acknowledgements[0]).toContain("still being confirmed")
  })

  test("releases after a definite RunTask rejection", async () => {
    const released: string[] = []

    const promoted = await promoteToJobWithDependencies(
      JOB_PROMOTION_INPUT,
      TEST_LOG,
      promotionDependencies({
        releaseLock: async workspaceLockId => {
          released.push(workspaceLockId)
        },
        runJob: async () => {
          throw Object.assign(new Error("invalid task definition"), {
            name: "ClientException",
            $metadata: { httpStatusCode: 400 },
          })
        },
      })
    )

    expect(promoted).toBe(false)
    expect(released).toEqual([JOB_PROMOTION_INPUT.workspaceLockId])
  })

  test("treats an explicit throttling response as a definite non-acceptance", async () => {
    const released: string[] = []
    let attempts = 0

    const promoted = await promoteToJobWithDependencies(
      JOB_PROMOTION_INPUT,
      TEST_LOG,
      promotionDependencies({
        releaseLock: async workspaceLockId => {
          released.push(workspaceLockId)
        },
        runJob: async () => {
          attempts += 1
          throw Object.assign(new Error("rate exceeded"), {
            name: "ThrottlingException",
            $metadata: { httpStatusCode: 429 },
          })
        },
      })
    )

    expect(promoted).toBe(false)
    expect(attempts).toBe(1)
    expect(released).toEqual([JOB_PROMOTION_INPUT.workspaceLockId])
  })

  test("does not release an accepted task when acknowledgement delivery throws", async () => {
    const released: string[] = []

    const promoted = await promoteToJobWithDependencies(
      JOB_PROMOTION_INPUT,
      TEST_LOG,
      promotionDependencies({
        releaseLock: async workspaceLockId => {
          released.push(workspaceLockId)
        },
        sendResponse: async () => {
          throw new Error("Chat unavailable")
        },
      })
    )

    expect(promoted).toBe(true)
    expect(released).toEqual([])
  })

  test("releases a payload failure that occurs before RunTask", async () => {
    const released: string[] = []
    let runTaskCalled = false

    const promoted = await promoteToJobWithDependencies(
      {
        ...JOB_PROMOTION_INPUT,
        reason: "context-overflow",
        originalPrompt: "x".repeat(20_000),
      },
      TEST_LOG,
      promotionDependencies({
        releaseLock: async workspaceLockId => {
          released.push(workspaceLockId)
        },
        runJob: async () => {
          runTaskCalled = true
          return "unexpected"
        },
      })
    )

    expect(promoted).toBe(false)
    expect(runTaskCalled).toBe(false)
    expect(released).toEqual([JOB_PROMOTION_INPUT.workspaceLockId])
  })
})

describe("background promotion bounded idempotent retry", () => {
  test("recovers an ambiguous first attempt with the same client token", async () => {
    const clientTokens: string[] = []
    const released: string[] = []
    const acknowledgements: string[] = []
    let attempt = 0

    const promoted = await promoteToJobWithDependencies(
      JOB_PROMOTION_INPUT,
      TEST_LOG,
      promotionDependencies({
        releaseLock: async workspaceLockId => {
          released.push(workspaceLockId)
        },
        runJob: async (_config, _payload, clientToken) => {
          clientTokens.push(clientToken)
          attempt += 1
          if (attempt === 1) {
            throw Object.assign(new Error("response lost"), {
              name: "TimeoutError",
            })
          }
          return "arn:aws:ecs:us-east-1:123456789012:task/task-123"
        },
        sendResponse: async (_space, _thread, text) => {
          acknowledgements.push(text)
          return "delivered"
        },
      })
    )

    expect(promoted).toBe(true)
    expect(clientTokens).toHaveLength(2)
    expect(new Set(clientTokens).size).toBe(1)
    expect(released).toEqual([])
    expect(acknowledgements[0]).toContain("moved it to a background job")
  })

  test("retains after ambiguity even if the retry is explicitly rejected", async () => {
    const released: string[] = []
    let attempt = 0

    const promoted = await promoteToJobWithDependencies(
      JOB_PROMOTION_INPUT,
      TEST_LOG,
      promotionDependencies({
        releaseLock: async workspaceLockId => {
          released.push(workspaceLockId)
        },
        runJob: async () => {
          attempt += 1
          if (attempt === 1) {
            throw Object.assign(new Error("response lost"), {
              name: "TimeoutError",
            })
          }
          throw Object.assign(new Error("explicit retry rejection"), {
            name: "ClientException",
            $metadata: { httpStatusCode: 400 },
          })
        },
      })
    )

    expect(promoted).toBe(true)
    expect(attempt).toBe(2)
    expect(released).toEqual([])
  })
})
