/** @jest-environment node */

import { agentRouterTestHelpers } from "../../infra/lambdas/agent-router/index"
import {
  ownerRuntimeSessionId,
  ownerWorkspaceLockId,
  scheduledConversationSessionId,
} from "../../infra/lambdas/agent-cron/workspace-identity"
import {
  buildJobPayload,
  parseJobPayload,
  resolveJobInvocation,
} from "../../infra/lambdas/agent-router/job-promotion"

const {
  ownerSessionId: routerOwnerRuntimeSessionId,
  ownerWorkspaceLockId: routerOwnerWorkspaceLockId,
} = agentRouterTestHelpers

describe("owner workspace identity contract", () => {
  it("keeps cron and Chat on the exact same runtime and workspace mutex", () => {
    const previousBuildTag = process.env.AGENT_BUILD_TAG
    const workspacePrefix = "hagelk-db0f32b5"
    const buildTag = "sha256:deployed-image-config"
    // ownerSessionId intentionally ignores the Chat envelope because runtime
    // affinity is owner-wide. The cast makes that contract explicit here.
    const ignoredHuman = {} as Parameters<
      typeof routerOwnerRuntimeSessionId
    >[0]

    try {
      process.env.AGENT_BUILD_TAG = buildTag
      expect(ownerRuntimeSessionId(workspacePrefix, buildTag)).toBe(
        routerOwnerRuntimeSessionId(ignoredHuman, { workspacePrefix })
      )
      expect(ownerWorkspaceLockId(workspacePrefix)).toBe(
        routerOwnerWorkspaceLockId({ workspacePrefix })
      )
    } finally {
      if (previousBuildTag === undefined) {
        delete process.env.AGENT_BUILD_TAG
      } else {
        process.env.AGENT_BUILD_TAG = previousBuildTag
      }
    }
  })

  it("meets the AgentCore runtime id contract through job promotion", () => {
    const previousBuildTag = process.env.AGENT_BUILD_TAG
    const workspacePrefix = "owner-a1b2c3d4"
    const buildTag = "sha256:deployed-image-config"
    const ignoredHuman = {} as Parameters<
      typeof routerOwnerRuntimeSessionId
    >[0]

    try {
      process.env.AGENT_BUILD_TAG = buildTag
      const routerSessionId = routerOwnerRuntimeSessionId(ignoredHuman, {
        workspacePrefix,
      })
      const cronSessionId = ownerRuntimeSessionId(workspacePrefix, buildTag)

      expect(routerSessionId).toBe(cronSessionId)
      expect(routerSessionId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      expect(Buffer.byteLength(routerSessionId, "utf8")).toBeLessThanOrEqual(
        100
      )
      expect(routerSessionId).toHaveLength(98)

      const job = parseJobPayload(
        buildJobPayload({
          sessionId: routerSessionId,
          workspaceLockId: ownerWorkspaceLockId(workspacePrefix),
          conversationSessionId: "agent-chat-thread-one",
          reason: "context-overflow",
          lockToken: "12345678-1234-1234-1234-123456789abc",
          runtimeId: "runtime-dev",
          userEmail: "owner@example.com",
          displayName: "Owner",
          workspacePrefix,
          spaceName: "spaces/dev",
          threadName: "spaces/dev/threads/one",
          isDM: false,
          originalPrompt: "Finish the task",
        })
      )

      expect(job.sessionId).toBe(routerSessionId)
      expect(resolveJobInvocation(job).invokeSessionId).toBe(routerSessionId)
    } finally {
      if (previousBuildTag === undefined) {
        delete process.env.AGENT_BUILD_TAG
      } else {
        process.env.AGENT_BUILD_TAG = previousBuildTag
      }
    }
  })

  it("rotates runtime affinity but never the durable workspace mutex", () => {
    const workspacePrefix = "owner-a1b2c3d4"

    expect(
      ownerRuntimeSessionId(workspacePrefix, "deploy-one")
    ).not.toBe(ownerRuntimeSessionId(workspacePrefix, "deploy-two"))
    expect(ownerWorkspaceLockId(workspacePrefix)).toBe(
      ownerWorkspaceLockId(workspacePrefix)
    )
  })

  it("isolates schedule transcripts without changing owner affinity", () => {
    const workspacePrefix = "owner-a1b2c3d4"
    const first = scheduledConversationSessionId(
      workspacePrefix,
      "schedule-one",
      "2026-07-30"
    )
    const same = scheduledConversationSessionId(
      workspacePrefix,
      "schedule-one",
      "2026-07-30"
    )
    const anotherSchedule = scheduledConversationSessionId(
      workspacePrefix,
      "schedule-two",
      "2026-07-30"
    )
    const anotherDay = scheduledConversationSessionId(
      workspacePrefix,
      "schedule-one",
      "2026-07-31"
    )

    expect(same).toBe(first)
    expect(anotherSchedule).not.toBe(first)
    expect(anotherDay).not.toBe(first)
    for (const sessionId of [first, anotherSchedule, anotherDay]) {
      expect(sessionId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      expect(sessionId.length).toBeLessThanOrEqual(256)
    }
  })
})
