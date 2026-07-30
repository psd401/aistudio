import fs from "node:fs"
import path from "node:path"
import {
  backfilledTargetInput,
  backfillScheduleRecordPage,
  backfillScheduleTargetPage,
  backfillUpdateRequest,
  legacyScheduleRecordUpgrade,
  legacySchedulerExpression,
  selectTrustedOwnerProfile,
  type ScheduleTargetBackfillDependencies,
  withIamPropagationRetry,
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
const INLINE_LEGACY_INPUT = JSON.stringify({
  scheduleId: "schedule-id",
  scheduleName: "Morning dispatch",
  userEmail: "owner@psd401.net",
  googleIdentity: "users/12345",
  dmSpaceName: "spaces/legacy-inline",
  prompt: "Generate the dispatch",
})
const SCHEDULE_DLQ_ARN =
  "arn:aws:sqs:us-west-2:123:psd-agent-async-dlq-prod"

function schedule(
  input = LEGACY_INPUT,
  overrides: {
    version?: number | null
    expression?: string
    state?: "ENABLED" | "DISABLED"
    currentPolicy?: boolean
  } = {},
) {
  const version = overrides.version === undefined ? 4 : overrides.version
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
      Input: JSON.stringify({
        ...parsedInput,
        ...(version === null ? {} : { version }),
      }),
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
    listRecords: jest.fn().mockResolvedValue({ records: [] }),
    getRecord: jest.fn().mockResolvedValue({
      userId: "owner@psd401.net",
      ownerEmail: "owner@psd401.net",
      scheduleId: "schedule-id",
      version: 4,
    }),
    loadOwnerProfile: jest.fn().mockResolvedValue({
      dmSpaceName: "spaces/trusted-owner-dm",
      workspacePrefix: "owner-workspace",
    }),
    updateRecord: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue({ names: [] }),
    get: jest.fn().mockResolvedValue(schedule()),
    update: jest.fn().mockResolvedValue(undefined),
    queueContinuation: jest.fn().mockResolvedValue(undefined),
    withMutationLock: async (_identity, execute) => execute(),
    recordInvalidRecord: jest.fn(),
    recordInvalidTarget: jest.fn(),
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

  it("upgrades the exact inline legacy target to a minimal record-bound input", () => {
    expect(
      JSON.parse(backfilledTargetInput(INLINE_LEGACY_INPUT, 1) ?? ""),
    ).toEqual({
      ownerEmail: "owner@psd401.net",
      scheduleId: "schedule-id",
      version: 1,
      scheduledTime: "<aws.scheduler.scheduled-time>",
    })
    expect(backfilledTargetInput(INLINE_LEGACY_INPUT, 1)).not.toContain(
      "prompt",
    )
    expect(backfilledTargetInput(INLINE_LEGACY_INPUT, 1)).not.toContain(
      "googleIdentity",
    )
  })

  it("rejects malformed or unbound target inputs", () => {
    expect(() => backfilledTargetInput("not-json")).toThrow(/valid JSON/)
    expect(() => backfilledTargetInput(JSON.stringify({ scheduleId: "id" })))
      .toThrow(/owner-bound/)
    expect(() => backfilledTargetInput(JSON.stringify({
      ...JSON.parse(LEGACY_INPUT),
      ownerEmail: " ",
    }))).toThrow(/owner-bound/)
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
})

describe("agent schedule target deployment migration", () => {
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
      phase: "targets",
      scanned: 2,
      updated: 1,
      invalid: 0,
      continuationQueued: true,
    })
    expect(deps.update).toHaveBeenCalledTimes(1)
    expect(deps.queueContinuation).toHaveBeenCalledWith({
      phase: "targets",
      nextToken: "next-page",
    })
  })

  it("isolates a malformed target and continues the fleet migration", async () => {
    const valid = schedule()
    const malformed = schedule()
    malformed.Name = `${valid.Name}-malformed`
    malformed.Target.Input = "not-json"
    const blankOwner = schedule(JSON.stringify({
      ...JSON.parse(LEGACY_INPUT),
      ownerEmail: " ",
    }))
    blankOwner.Name = `${valid.Name}-blank-owner`
    const deps = dependencies({
      list: jest.fn().mockResolvedValue({
        names: [malformed.Name, blankOwner.Name, valid.Name],
        nextToken: "next-page",
      }),
      get: jest.fn(async (name: string) => {
        if (name === malformed.Name) return malformed
        if (name === blankOwner.Name) return blankOwner
        return valid
      }),
    })

    await expect(
      backfillScheduleTargetPage(undefined, deps),
    ).resolves.toEqual({
      phase: "targets",
      scanned: 3,
      updated: 1,
      invalid: 2,
      continuationQueued: true,
    })
    expect(deps.recordInvalidTarget).toHaveBeenCalledWith(
      malformed.Name,
      expect.stringMatching(/valid JSON/),
    )
    expect(deps.recordInvalidTarget).toHaveBeenCalledWith(
      blankOwner.Name,
      expect.stringMatching(/owner-bound/),
    )
    expect(deps.update).toHaveBeenCalledTimes(1)
    expect(deps.queueContinuation).toHaveBeenCalledWith({
      phase: "targets",
      nextToken: "next-page",
    })
  })

  it("still retries operational failures instead of skipping them", async () => {
    const current = schedule()
    const outage = new Error("Scheduler throttled")
    const deps = dependencies({
      list: jest.fn().mockResolvedValue({
        names: [current.Name],
        nextToken: "next-page",
      }),
      get: jest.fn().mockRejectedValue(outage),
    })

    await expect(
      backfillScheduleTargetPage(undefined, deps),
    ).rejects.toBe(outage)
    expect(deps.recordInvalidTarget).not.toHaveBeenCalled()
    expect(deps.queueContinuation).not.toHaveBeenCalled()
  })
})

describe("agent schedule target backfill safety", () => {
  it("migrates inline legacy input using the authoritative migrated version", async () => {
    const legacy = schedule(INLINE_LEGACY_INPUT, { version: null })
    const deps = dependencies({
      list: jest.fn().mockResolvedValue({ names: [legacy.Name] }),
      get: jest.fn().mockResolvedValue(legacy),
      getRecord: jest.fn().mockResolvedValue({
        userId: "owner@psd401.net",
        ownerEmail: "owner@psd401.net",
        scheduleId: "schedule-id",
        version: 1,
      }),
    })

    await expect(
      backfillScheduleTargetPage(undefined, deps),
    ).resolves.toMatchObject({ phase: "targets", updated: 1, invalid: 0 })
    const input = (deps.update as jest.Mock).mock.calls[0][0].Target.Input
    expect(JSON.parse(input)).toEqual({
      ownerEmail: "owner@psd401.net",
      scheduleId: "schedule-id",
      version: 1,
      scheduledTime: "<aws.scheduler.scheduled-time>",
    })
  })

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
      getRecord: jest.fn().mockResolvedValue({
        userId: "owner@psd401.net",
        ownerEmail: "owner@psd401.net",
        scheduleId: "schedule-id",
        version: 5,
      }),
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

describe("agent schedule legacy record backfill", () => {
  const legacyRecord = {
    userId: "owner@psd401.net",
    scheduleId: "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
    name: "Morning Dispatch",
    prompt: "Generate my dispatch",
    cronExpression: "0 6 * * MON-FRI",
    timezone: "America/Los_Angeles",
    enabled: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  }

  it("derives Scheduler cadence without changing the stored cron expression", () => {
    expect(legacySchedulerExpression("0 6 * * MON-FRI")).toBe(
      "cron(0 6 ? * MON-FRI *)",
    )
    expect(
      legacyScheduleRecordUpgrade(legacyRecord, {
        dmSpaceName: "spaces/trusted-owner-dm",
        workspacePrefix: "owner-workspace",
      }),
    ).toEqual({
      version: 1,
      ownerEmail: "owner@psd401.net",
      schedulerExpression: "cron(0 6 ? * MON-FRI *)",
      workspacePrefix: "owner-workspace",
      dmSpaceName: "spaces/trusted-owner-dm",
    })
    expect(legacyRecord.cronExpression).toBe("0 6 * * MON-FRI")
  })

  it("canonicalizes an owner that only differs by case or whitespace", () => {
    expect(
      legacyScheduleRecordUpgrade({
        ...legacyRecord,
        version: 1,
        ownerEmail: " Owner@PSD401.net ",
        schedulerExpression: "cron(0 6 ? * MON-FRI *)",
        workspacePrefix: "owner-workspace",
        dmSpaceName: "spaces/trusted-owner-dm",
      }, null),
    ).toEqual({
      ownerEmail: "owner@psd401.net",
    })
  })

  it("prefers a duplicate owner profile with a usable DM destination", () => {
    expect(selectTrustedOwnerProfile("owner@psd401.net", [
      {
        email: "owner@psd401.net",
        googleIdentity: "users/12345",
        workspacePrefix: "stale-workspace",
      },
      {
        email: "Owner@PSD401.net ",
        workspacePrefix: "usable-workspace",
        dmSpaceName: "spaces/usable-dm",
      },
    ])).toEqual({
      workspacePrefix: "usable-workspace",
      dmSpaceName: "spaces/usable-dm",
    })
  })

  it("migrates an exact legacy row before queuing target migration", async () => {
    const deps = dependencies({
      listRecords: jest.fn().mockResolvedValue({
        records: [legacyRecord],
      }),
      getRecord: jest.fn().mockResolvedValue(legacyRecord),
    })

    await expect(
      backfillScheduleRecordPage(undefined, deps),
    ).resolves.toEqual({
      phase: "records",
      scanned: 1,
      updated: 1,
      invalid: 0,
      continuationQueued: true,
    })
    expect(deps.updateRecord).toHaveBeenCalledWith(
      {
        ownerEmail: "owner@psd401.net",
        scheduleId: legacyRecord.scheduleId,
      },
      {
        version: 1,
        ownerEmail: "owner@psd401.net",
        schedulerExpression: "cron(0 6 ? * MON-FRI *)",
        workspacePrefix: "owner-workspace",
        dmSpaceName: "spaces/trusted-owner-dm",
      },
    )
    expect(deps.queueContinuation).toHaveBeenCalledWith({
      phase: "targets",
    })
  })

  it("continues record pagination and isolates an owner without a trusted DM", async () => {
    const deps = dependencies({
      listRecords: jest.fn().mockResolvedValue({
        records: [legacyRecord],
        nextToken: "record-page-2",
      }),
      getRecord: jest.fn().mockResolvedValue(legacyRecord),
      loadOwnerProfile: jest.fn().mockResolvedValue({
        workspacePrefix: "owner-workspace",
      }),
    })

    await expect(
      backfillScheduleRecordPage(undefined, deps),
    ).resolves.toMatchObject({
      phase: "records",
      updated: 0,
      invalid: 1,
      continuationQueued: true,
    })
    expect(deps.recordInvalidRecord).toHaveBeenCalledWith(
      {
        ownerEmail: "owner@psd401.net",
        scheduleId: legacyRecord.scheduleId,
      },
      expect.stringMatching(/direct-message destination/),
    )
    expect(deps.queueContinuation).toHaveBeenCalledWith({
      phase: "records",
      nextToken: "record-page-2",
    })
  })
})

describe("agent schedule backfill IAM propagation retry", () => {
  it("backs off beyond Lambda's three async delivery attempts", async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("not propagated"), {
          name: "AccessDeniedException",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("still propagating"), {
          name: "AccessDeniedException",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("still propagating"), {
          name: "AccessDeniedException",
        }),
      )
      .mockResolvedValue("migrated")
    const wait = jest.fn().mockResolvedValue(undefined)

    await expect(
      withIamPropagationRetry(operation, wait),
    ).resolves.toBe("migrated")
    expect(operation).toHaveBeenCalledTimes(4)
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000,
      2_000,
      4_000,
    ])
  })
})

describe("agent schedule target backfill infrastructure", () => {
  const stackSource = stripComments(
    fs.readFileSync(
      path.join(process.cwd(), "infra/lib/agent-platform-stack.ts"),
      "utf8",
    ),
  )
  const frontendSource = stripComments(
    fs.readFileSync(
      path.join(process.cwd(), "infra/lib/frontend-stack-ecs.ts"),
      "utf8",
    ),
  )
  const appSource = stripComments(
    fs.readFileSync(
      path.join(process.cwd(), "infra/bin/infra.ts"),
      "utf8",
    ),
  )

  it("creates the migration worker without triggering it before the frontend", () => {
    expect(stackSource).toContain(
      "this.createScheduleTargetBackfill(props, resources)",
    )
    expect(stackSource).not.toContain(
      "ScheduleTargetBackfillCustomResource",
    )
    expect(stackSource).toContain("return backfill")
  })

  it("runs the versioned migration only after lock-aware ECS is steady", () => {
    expect(frontendSource).toContain(
      "ScheduleTargetBackfillAfterFrontend",
    )
    expect(frontendSource).toContain(
      "const migrationVersion = 'legacy-schedule-records-and-targets-v4'",
    )
    expect(frontendSource).toContain("onUpdate: invocation")
    expect(frontendSource).toContain("InvocationType: 'Event'")
    expect(frontendSource).toContain(
      "trigger.node.addDependency(this.ecsService.service)",
    )
    expect(appSource).toContain(
      "scheduleTargetBackfillFunction:",
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
    expect(backfill).toContain("'dynamodb:GetItem'")
    expect(backfill).toContain("'dynamodb:Scan'")
    expect(backfill).toContain("'dynamodb:Query'")
    expect(backfill).toContain("'dynamodb:DeleteItem'")
    expect(backfill).toContain("'dynamodb:UpdateItem'")
    expect(backfill).toContain("resources.usersTable.tableArn")
    expect(backfill).toContain(
      "USERS_TABLE: resources.usersTable.tableName",
    )
    expect(backfill).toContain("resources.schedulerInvokeRole.roleArn")
    expect(backfill).toContain("deadLetterQueue: resources.agentAsyncDlq")
    expect(backfill).toContain("'lambda:InvokeFunction'")
  })
})
