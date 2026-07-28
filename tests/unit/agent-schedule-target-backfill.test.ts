import fs from "node:fs"
import path from "node:path"
import {
  backfilledTargetInput,
  backfillScheduleTargetPage,
  backfillUpdateRequest,
  type ScheduleTargetBackfillDependencies,
} from "../../infra/lambdas/agent-schedule-target-backfill/backfill"
import {
  scheduleMutationLockKey as backfillMutationLockKey,
} from "../../infra/lambdas/agent-schedule-target-backfill/mutation-lock"
import {
  scheduleMutationLockKey as serviceMutationLockKey,
} from "../../lib/agent-schedules/mutation-lock"
import { stripComments } from "../helpers/strip-ts-comments"

const LEGACY_INPUT = JSON.stringify({
  ownerEmail: "owner@psd401.net",
  scheduleId: "schedule-id",
  version: 4,
})
const SCHEDULE_DLQ_ARN =
  "arn:aws:sqs:us-west-2:123:psd-agent-async-dlq-prod"

function schedule(
  input = LEGACY_INPUT,
  overrides: {
    version?: number
    expression?: string
    state?: "ENABLED" | "DISABLED"
    currentPolicy?: boolean
  } = {},
) {
  const version = overrides.version ?? 4
  const parsedInput = JSON.parse(input)
  return {
    $metadata: {},
    Name: "psd-agent-prod-schedule-id",
    GroupName: "psd-agent-prod",
    ScheduleExpression:
      overrides.expression ?? "cron(0 6 * * ? *)",
    ScheduleExpressionTimezone: "America/Los_Angeles",
    FlexibleTimeWindow: { Mode: "OFF" as const },
    State: overrides.state ?? ("ENABLED" as const),
    ActionAfterCompletion: "NONE" as const,
    Description: "PSD agent schedule schedule-id",
    Target: {
      Arn: "arn:aws:lambda:us-west-2:123:function:psd-agent-cron-prod",
      RoleArn: "arn:aws:iam::123:role/psd-agent-scheduler-invoke-prod",
      Input: JSON.stringify({ ...parsedInput, version }),
      ...(overrides.currentPolicy
        ? {
            DeadLetterConfig: { Arn: SCHEDULE_DLQ_ARN },
            RetryPolicy: {
              MaximumEventAgeInSeconds: 3600,
              MaximumRetryAttempts: 5,
            },
          }
        : {}),
    },
  }
}

function dependencies(
  overrides: Partial<ScheduleTargetBackfillDependencies> = {},
): ScheduleTargetBackfillDependencies {
  return {
    scheduleDlqArn: SCHEDULE_DLQ_ARN,
    list: jest.fn().mockResolvedValue({ names: [] }),
    get: jest.fn().mockResolvedValue(schedule()),
    update: jest.fn().mockResolvedValue(undefined),
    queueContinuation: jest.fn().mockResolvedValue(undefined),
    withMutationLock: async (_identity, execute) => execute(),
    ...overrides,
  }
}

describe("agent schedule target deployment backfill", () => {
  it("uses the exact same mutation-lock key as the schedule service", () => {
    const identity = {
      ownerEmail: "Owner@PSD401.net ",
      scheduleId: "schedule-id",
    }
    expect(backfillMutationLockKey(identity)).toEqual(
      serviceMutationLockKey(identity),
    )
  })

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
    expect(
      backfillUpdateRequest(current, "new-input", SCHEDULE_DLQ_ARN),
    ).toEqual({
      Name: current.Name,
      GroupName: current.GroupName,
      ScheduleExpression: current.ScheduleExpression,
      ScheduleExpressionTimezone: current.ScheduleExpressionTimezone,
      FlexibleTimeWindow: current.FlexibleTimeWindow,
      State: current.State,
      ActionAfterCompletion: current.ActionAfterCompletion,
      Description: current.Description,
      Target: {
        ...current.Target,
        Input: "new-input",
        DeadLetterConfig: { Arn: SCHEDULE_DLQ_ARN },
        RetryPolicy: {
          MaximumEventAgeInSeconds: 3600,
          MaximumRetryAttempts: 5,
        },
      },
    })
  })

  it("updates legacy targets and durably continues pagination", async () => {
    const first = schedule()
    const alreadyCurrent = schedule(JSON.stringify({
      ...JSON.parse(LEGACY_INPUT),
      scheduledTime: "<aws.scheduler.scheduled-time>",
    }), { currentPolicy: true })
    const deps = dependencies({
      list: jest.fn().mockResolvedValue({
        names: [first.Name, `${first.Name}-current`],
        nextToken: "next-page",
      }),
      get: jest.fn(async (name: string) =>
        name === first.Name ? first : alreadyCurrent
      ),
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

describe("agent schedule target backfill safety", () => {
  it("adds the DLQ and bounded retry policy even when Input is current", async () => {
    const currentInput = JSON.stringify({
      ...JSON.parse(LEGACY_INPUT),
      scheduledTime: "<aws.scheduler.scheduled-time>",
    })
    const legacyPolicy = schedule(currentInput)
    const deps = dependencies({
      list: jest.fn().mockResolvedValue({ names: [legacyPolicy.Name] }),
      get: jest.fn().mockResolvedValue(legacyPolicy),
    })

    await expect(
      backfillScheduleTargetPage(undefined, deps),
    ).resolves.toMatchObject({ updated: 1 })
    expect(deps.update).toHaveBeenCalledWith(
      expect.objectContaining({
        Target: expect.objectContaining({
          Input: legacyPolicy.Target.Input,
          DeadLetterConfig: { Arn: SCHEDULE_DLQ_ARN },
          RetryPolicy: {
            MaximumEventAgeInSeconds: 3600,
            MaximumRetryAttempts: 5,
          },
        }),
      }),
    )
  })

  it("locks and re-reads before preserving mutable Scheduler fields", async () => {
    const initial = schedule()
    const current = schedule(
      JSON.stringify({
        ...JSON.parse(LEGACY_INPUT),
        version: 5,
      }),
      {
        version: 5,
        expression: "cron(30 7 * * ? *)",
        state: "DISABLED",
      },
    )
    const get = jest.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(current)
    const observedLocks: Array<{
      ownerEmail: string
      scheduleId: string
      version?: number
    }> = []
    const withMutationLock = async <T,>(
      identity: {
        ownerEmail: string
        scheduleId: string
        version?: number
      },
      execute: () => Promise<T>,
    ): Promise<T> => {
      observedLocks.push(identity)
      return execute()
    }
    const deps = dependencies({
      list: jest.fn().mockResolvedValue({ names: [initial.Name] }),
      get,
      withMutationLock,
    })

    await backfillScheduleTargetPage(undefined, deps)

    expect(observedLocks).toEqual([{
      ownerEmail: "owner@psd401.net",
      scheduleId: "schedule-id",
      version: 4,
    }])
    expect(deps.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ScheduleExpression: "cron(30 7 * * ? *)",
        State: "DISABLED",
        Target: expect.objectContaining({
          Input: expect.stringContaining('"version":5'),
        }),
      }),
    )
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
      "migrationVersion: 'scheduled-time-delivery-policy-v2'",
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
    expect(backfill).toContain("'dynamodb:PutItem'")
    expect(backfill).toContain("'dynamodb:DeleteItem'")
    expect(backfill).toContain("'dynamodb:UpdateItem'")
    expect(backfill).toContain("resources.schedulerInvokeRole.roleArn")
    expect(backfill).toContain("deadLetterQueue: resources.agentAsyncDlq")
    expect(backfill).toContain("'lambda:InvokeFunction'")
  })
})
