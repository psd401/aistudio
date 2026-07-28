import fs from "node:fs"
import path from "node:path"
import {
  backfilledTargetInput,
  backfillScheduleTargetPage,
  backfillUpdateRequest,
  type ScheduleTargetBackfillDependencies,
} from "../../infra/lambdas/agent-schedule-target-backfill/backfill"
import { stripComments } from "../helpers/strip-ts-comments"

const LEGACY_INPUT = JSON.stringify({
  ownerEmail: "owner@psd401.net",
  scheduleId: "schedule-id",
  version: 4,
})

function schedule(input = LEGACY_INPUT) {
  return {
    $metadata: {},
    Name: "psd-agent-prod-schedule-id",
    GroupName: "psd-agent-prod",
    ScheduleExpression: "cron(0 6 * * ? *)",
    ScheduleExpressionTimezone: "America/Los_Angeles",
    FlexibleTimeWindow: { Mode: "OFF" as const },
    State: "ENABLED" as const,
    ActionAfterCompletion: "NONE" as const,
    Description: "PSD agent schedule schedule-id",
    Target: {
      Arn: "arn:aws:lambda:us-west-2:123:function:psd-agent-cron-prod",
      RoleArn: "arn:aws:iam::123:role/psd-agent-scheduler-invoke-prod",
      Input: input,
      RetryPolicy: {
        MaximumEventAgeInSeconds: 3600,
        MaximumRetryAttempts: 5,
      },
    },
  }
}

function dependencies(
  overrides: Partial<ScheduleTargetBackfillDependencies> = {},
): ScheduleTargetBackfillDependencies {
  return {
    list: jest.fn().mockResolvedValue({ names: [] }),
    get: jest.fn().mockResolvedValue(schedule()),
    update: jest.fn().mockResolvedValue(undefined),
    queueContinuation: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("agent schedule target deployment backfill", () => {
  it("adds immutable Scheduler context without changing the reference", () => {
    expect(JSON.parse(backfilledTargetInput(LEGACY_INPUT) ?? "")).toEqual({
      ownerEmail: "owner@psd401.net",
      scheduleId: "schedule-id",
      version: 4,
      scheduledTime: "<aws.scheduler.scheduled-time>",
    })
    expect(
      backfilledTargetInput(JSON.stringify({
        ...JSON.parse(LEGACY_INPUT),
        scheduledTime: "<aws.scheduler.scheduled-time>",
      })),
    ).toBeNull()
  })

  it("rejects malformed or unbound target inputs", () => {
    expect(() => backfilledTargetInput("not-json")).toThrow(/valid JSON/)
    expect(() => backfilledTargetInput(JSON.stringify({ scheduleId: "id" })))
      .toThrow(/owner-bound/)
  })

  it("preserves every mutable Scheduler setting while changing Input", () => {
    const current = schedule()
    expect(backfillUpdateRequest(current, "new-input")).toEqual({
      Name: current.Name,
      GroupName: current.GroupName,
      ScheduleExpression: current.ScheduleExpression,
      ScheduleExpressionTimezone: current.ScheduleExpressionTimezone,
      FlexibleTimeWindow: current.FlexibleTimeWindow,
      State: current.State,
      ActionAfterCompletion: current.ActionAfterCompletion,
      Description: current.Description,
      Target: { ...current.Target, Input: "new-input" },
    })
  })

  it("updates legacy targets and durably continues pagination", async () => {
    const first = schedule()
    const alreadyCurrent = schedule(JSON.stringify({
      ...JSON.parse(LEGACY_INPUT),
      scheduledTime: "<aws.scheduler.scheduled-time>",
    }))
    const deps = dependencies({
      list: jest.fn().mockResolvedValue({
        names: [first.Name, `${first.Name}-current`],
        nextToken: "next-page",
      }),
      get: jest.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(alreadyCurrent),
    })

    await expect(
      backfillScheduleTargetPage(undefined, deps),
    ).resolves.toEqual({
      scanned: 2,
      updated: 1,
      continuationQueued: true,
    })
    expect(deps.update).toHaveBeenCalledTimes(1)
    expect(deps.queueContinuation).toHaveBeenCalledWith("next-page")
  })
})

describe("agent schedule target backfill infrastructure", () => {
  const stackSource = stripComments(
    fs.readFileSync(
      path.join(process.cwd(), "infra/lib/agent-platform-stack.ts"),
      "utf8",
    ),
  )

  it("runs the versioned migration automatically during deployment", () => {
    expect(stackSource).toContain(
      "this.createScheduleTargetBackfill(props, resources)",
    )
    expect(stackSource).toContain(
      "ScheduleTargetBackfillCustomResource",
    )
    expect(stackSource).toContain(
      "migrationVersion: 'scheduled-time-v1'",
    )
  })

  it("uses a dedicated least-privilege role and alarmed async continuation", () => {
    const start = stackSource.indexOf(
      "private createScheduleTargetBackfill(",
    )
    const end = stackSource.indexOf(
      "private scheduleTargetBackfillCode(",
      start,
    )
    const backfill = stackSource.slice(start, end)

    expect(backfill).toContain("ServiceRoleFactory.createLambdaRole(")
    expect(backfill).toContain("'scheduler:ListSchedules'")
    expect(backfill).toContain("resources: ['*']")
    expect(backfill).toContain("'scheduler:GetSchedule'")
    expect(backfill).toContain("'scheduler:UpdateSchedule'")
    expect(backfill).toContain("'iam:PassRole'")
    expect(backfill).toContain("resources.schedulerInvokeRole.roleArn")
    expect(backfill).toContain("deadLetterQueue: resources.agentAsyncDlq")
    expect(backfill).toContain("'lambda:InvokeFunction'")
  })
})
