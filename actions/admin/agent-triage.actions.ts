"use server"

/**
 * Admin server actions for the email triage feature.
 *
 * All actions require the `administrator` role and return `ActionState`.
 * Backing store is DynamoDB `psd-agent-triage-<env>` — direct AWS SDK
 * calls rather than going through Drizzle/Postgres because the table
 * lives in the agent platform stack, not the AI Studio main DB.
 */

import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb"
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb"

import { requireRole } from "@/lib/auth/role-helpers"
import { handleError, createSuccess } from "@/lib/error-utils"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import type { ActionState } from "@/types"

const REGION = process.env.AWS_REGION ?? "us-east-1"
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev"
const TRIAGE_TABLE = process.env.TRIAGE_TABLE ?? `psd-agent-triage-${ENVIRONMENT}`

let cached: DynamoDBDocumentClient | null = null
function ddb(): DynamoDBDocumentClient {
  if (!cached) {
    cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))
  }
  return cached
}

export interface TriageStateSummary {
  userEmail: string
  enabled: boolean
  enabledAt?: string
  disabledAt?: string | null
  labels?: Record<string, string>
  labelIdsByKey?: Record<string, string>
  lastHistoryId?: string
  lastPollAt?: string
  digest?: {
    enabled: boolean
    time?: string
    tz?: string
  }
  counts: {
    vipSenders: number
    muteSenders: number
    keywordRules: number
    escalationSenders: number
    escalationKeywords: number
    recentDecisions: number
    recentCorrections: number
    learnedPatterns: number
  }
  recentDecisions: Array<{
    messageId: string
    label: string
    source: string
    reason: string
    confidence: number
    ts: string
    fromEmail: string
    subject: string
  }>
  recentCorrections: Array<{
    messageId: string
    fromLabel: string
    toLabel: string
    ts: string
  }>
}

/**
 * One row per opted-in user, suitable for the dashboard's Triage tab.
 * Lightweight projection — no recentDecisions/recentCorrections arrays,
 * just counts and the last-decision summary. Scan is paginated; capped
 * at 500 users in dev/prod since a real district will stay under 1000.
 */
export interface TriageSummaryRow {
  userEmail: string
  enabled: boolean
  enabledAt?: string
  disabledAt?: string | null
  lastPollAt?: string
  digestEnabled: boolean
  ruleCount: number
  escalationCount: number
  recentDecisionsCount: number
  learnedPatternsCount: number
  lastDecision?: {
    ts: string
    label: string
    fromEmail: string
    subject: string
  } | null
}

export async function getTriageSummaryList(): Promise<
  ActionState<TriageSummaryRow[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getTriageSummaryList")
  const log = createLogger({ requestId, action: "getTriageSummaryList" })
  try {
    await requireRole("administrator")
    log.info("Scanning triage table for summary list")

    const rows: TriageSummaryRow[] = []
    let lastKey: Record<string, unknown> | undefined
    let pagesScanned = 0
    const MAX_PAGES = 5 // ~5 × 1MB = up to ~5000 rows
    do {
      const resp = await ddb().send(
        // @ts-expect-error — nested @smithy/types version mismatch between
        // @aws-sdk/lib-dynamodb and @aws-sdk/client-dynamodb. Same pattern as
        // GetCommand/UpdateCommand/DeleteCommand below.
        new ScanCommand({
          TableName: TRIAGE_TABLE,
          ExclusiveStartKey: lastKey,
          // Only fetch fields needed for TriageSummaryRow — avoids pulling
          // large recentDecisions / learnedPatterns arrays for every row.
          ProjectionExpression: "userEmail, enabled, enabledAt, disabledAt, lastPollAt, digestEnabled, rules, escalation, recentDecisions, learnedPatterns",
        }),
      )
      for (const item of (resp.Items ?? []) as Array<{
        userEmail: string
        enabled?: boolean
        enabledAt?: string
        disabledAt?: string | null
        lastPollAt?: string
        digestEnabled?: boolean
        rules?: {
          vipSenders?: unknown[]
          muteSenders?: unknown[]
          keywordRules?: unknown[]
        }
        escalation?: {
          senders?: unknown[]
          keywords?: unknown[]
        }
        recentDecisions?: Array<{
          ts: string
          label: string
          fromEmail: string
          subject: string
        }>
        learnedPatterns?: unknown[]
      }>) {
        const recent = item.recentDecisions ?? []
        const last = recent.length > 0 ? recent[recent.length - 1] : null
        rows.push({
          userEmail: item.userEmail,
          enabled: Boolean(item.enabled),
          enabledAt: item.enabledAt,
          disabledAt: item.disabledAt ?? null,
          lastPollAt: item.lastPollAt,
          digestEnabled: item.digestEnabled !== false,
          ruleCount:
            (item.rules?.vipSenders?.length ?? 0) +
            (item.rules?.muteSenders?.length ?? 0) +
            (item.rules?.keywordRules?.length ?? 0),
          escalationCount:
            (item.escalation?.senders?.length ?? 0) +
            (item.escalation?.keywords?.length ?? 0),
          recentDecisionsCount: recent.length,
          learnedPatternsCount: item.learnedPatterns?.length ?? 0,
          lastDecision: last
            ? {
                ts: last.ts,
                label: last.label,
                fromEmail: last.fromEmail,
                subject: last.subject,
              }
            : null,
        })
      }
      lastKey = resp.LastEvaluatedKey
      pagesScanned++
      if (pagesScanned >= MAX_PAGES) {
        log.warn("Triage scan hit page cap; truncating", { pages: pagesScanned })
        break
      }
    } while (lastKey)

    // Sort newest enable first so admin sees most recent setup at top.
    rows.sort((a, b) => (b.enabledAt ?? "").localeCompare(a.enabledAt ?? ""))
    timer({ status: "success" })
    return createSuccess(rows, `Found ${rows.length} triage rows`)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to list triage rows", {
      context: "getTriageSummaryList",
      requestId,
      operation: "getTriageSummaryList",
    })
  }
}

export async function getTriageState(
  userEmail: string,
): Promise<ActionState<TriageStateSummary | null>> {
  const requestId = generateRequestId()
  const timer = startTimer("getTriageState")
  const log = createLogger({ requestId, action: "getTriageState" })
  try {
    await requireRole("administrator")
    log.info("Fetching triage state", sanitizeForLogging({ userEmail }))

    const resp = await ddb().send(
      // @ts-expect-error — nested @smithy/types version mismatch (see above).
      new GetCommand({
        TableName: TRIAGE_TABLE,
        Key: { userEmail: userEmail.toLowerCase() },
      }),
    )
    if (!resp.Item) return createSuccess(null, "No triage row found")

    const row = resp.Item as {
      userEmail: string
      enabled?: boolean
      enabledAt?: string
      disabledAt?: string | null
      labels?: Record<string, string>
      labelIdsByKey?: Record<string, string>
      lastHistoryId?: string
      lastPollAt?: string
      digestEnabled?: boolean
      digestTime?: string
      digestTz?: string
      rules?: {
        vipSenders?: unknown[]
        muteSenders?: unknown[]
        keywordRules?: unknown[]
      }
      escalation?: {
        senders?: unknown[]
        keywords?: unknown[]
      }
      recentDecisions?: TriageStateSummary["recentDecisions"]
      recentCorrections?: TriageStateSummary["recentCorrections"]
      learnedPatterns?: unknown[]
    }

    const summary: TriageStateSummary = {
      userEmail: row.userEmail,
      enabled: Boolean(row.enabled),
      enabledAt: row.enabledAt,
      disabledAt: row.disabledAt ?? null,
      labels: row.labels,
      labelIdsByKey: row.labelIdsByKey,
      lastHistoryId: row.lastHistoryId,
      lastPollAt: row.lastPollAt,
      digest: {
        enabled: row.digestEnabled !== false,
        time: row.digestTime,
        tz: row.digestTz,
      },
      counts: {
        vipSenders: row.rules?.vipSenders?.length ?? 0,
        muteSenders: row.rules?.muteSenders?.length ?? 0,
        keywordRules: row.rules?.keywordRules?.length ?? 0,
        escalationSenders: row.escalation?.senders?.length ?? 0,
        escalationKeywords: row.escalation?.keywords?.length ?? 0,
        recentDecisions: row.recentDecisions?.length ?? 0,
        recentCorrections: row.recentCorrections?.length ?? 0,
        learnedPatterns: row.learnedPatterns?.length ?? 0,
      },
      recentDecisions: (row.recentDecisions ?? []).slice(-20).reverse(),
      recentCorrections: (row.recentCorrections ?? []).slice(-20).reverse(),
    }

    timer({ status: "success" })
    return createSuccess(summary, "Triage state retrieved")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch triage state", {
      context: "getTriageState",
      requestId,
      operation: "getTriageState",
    })
  }
}

/**
 * Pause triage for a user (sets enabled=false). Keeps rules, learned
 * patterns, and Gmail labels intact. Re-enable by calling
 * triage.enable from the agent.
 */
export async function pauseTriage(userEmail: string): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("pauseTriage")
  const log = createLogger({ requestId, action: "pauseTriage" })
  try {
    await requireRole("administrator")
    log.warn("Admin pausing user's triage", sanitizeForLogging({ userEmail }))
    await ddb().send(
      // @ts-expect-error — nested @smithy/types version mismatch (see above).
      new UpdateCommand({
        TableName: TRIAGE_TABLE,
        Key: { userEmail: userEmail.toLowerCase() },
        UpdateExpression: "SET enabled = :f, disabledAt = :now, adminPausedAt = :now",
        ConditionExpression: "attribute_exists(userEmail)",
        ExpressionAttributeValues: {
          ":f": false,
          ":now": new Date().toISOString(),
        },
      }),
    )
    timer({ status: "success" })
    return createSuccess(undefined, `Paused triage for ${userEmail}`)
  } catch (error) {
    // ConditionalCheckFailed means the user doesn't have a triage row
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
      timer({ status: "error" })
      return handleError(
        error as Error,
        `No triage row found for ${userEmail} — user may not have opted in yet.`,
        { context: "pauseTriage", requestId, operation: "pauseTriage" },
      )
    }
    timer({ status: "error" })
    return handleError(error, "Failed to pause triage", {
      context: "pauseTriage",
      requestId,
      operation: "pauseTriage",
    })
  }
}

/**
 * Clear learned patterns + correction history. Doesn't change rules
 * the user authored, doesn't disable triage. Use when a user reports
 * "the classifier suddenly went weird" and you want to reset only the
 * adaptive layer.
 */
export async function resetLearnedPatterns(
  userEmail: string,
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("resetLearnedPatterns")
  const log = createLogger({ requestId, action: "resetLearnedPatterns" })
  try {
    await requireRole("administrator")
    log.warn("Admin resetting learned patterns", sanitizeForLogging({ userEmail }))
    await ddb().send(
      // @ts-expect-error — nested @smithy/types version mismatch (see above).
      new UpdateCommand({
        TableName: TRIAGE_TABLE,
        Key: { userEmail: userEmail.toLowerCase() },
        UpdateExpression:
          "SET learnedPatterns = :empty, recentCorrections = :empty, adminResetAt = :now",
        ConditionExpression: "attribute_exists(userEmail)",
        ExpressionAttributeValues: {
          ":empty": [],
          ":now": new Date().toISOString(),
        },
      }),
    )
    timer({ status: "success" })
    return createSuccess(undefined, `Cleared learned patterns for ${userEmail}`)
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
      timer({ status: "error" })
      return handleError(
        error as Error,
        `No triage row found for ${userEmail} — user may not have opted in yet.`,
        { context: "resetLearnedPatterns", requestId, operation: "resetLearnedPatterns" },
      )
    }
    timer({ status: "error" })
    return handleError(error, "Failed to reset learned patterns", {
      context: "resetLearnedPatterns",
      requestId,
      operation: "resetLearnedPatterns",
    })
  }
}

/**
 * Force re-onboarding by deleting the user's triage row. The agent
 * skill will treat them as new the next time they ask to enable. Does
 * NOT delete Gmail labels or the digest schedule — those are the
 * user's to manage from chat (`disable --forget`).
 *
 * Use this when a user's state is corrupt and we'd rather start over.
 */
export async function forceReonboard(
  userEmail: string,
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("forceReonboard")
  const log = createLogger({ requestId, action: "forceReonboard" })
  try {
    await requireRole("administrator")
    log.warn("Admin forcing re-onboard (delete row)", sanitizeForLogging({ userEmail }))
    await ddb().send(
      // @ts-expect-error — nested @smithy/types version mismatch (see above).
      new DeleteCommand({
        TableName: TRIAGE_TABLE,
        Key: { userEmail: userEmail.toLowerCase() },
      }),
    )
    timer({ status: "success" })
    return createSuccess(
      undefined,
      `Deleted triage row for ${userEmail}. Gmail labels and digest schedule are NOT deleted — user can clean those up via 'disable --forget' from chat.`,
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to force re-onboard", {
      context: "forceReonboard",
      requestId,
      operation: "forceReonboard",
    })
  }
}
