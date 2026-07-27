import { describe, expect, test } from "bun:test"
import { agentRouterTestHelpers } from "./index"

const {
  normalizeChatEvent,
  cardClickMessageText,
  parseAgentCoreResult,
  totalAgentTokens,
} = agentRouterTestHelpers

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
