"use server"

/**
 * Administrator-only OneRoster settings, sync, and roster-browser actions.
 *
 * Roster rows are read-only here: the sync Lambda remains their sole writer.
 * The settings action stores only non-secret configuration and a Secrets
 * Manager ARN; ClassLink credentials never enter the application database.
 */

import { randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"
import { executeTransaction } from "@/lib/db/drizzle-client"
import { settings } from "@/lib/db/schema"
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle"
import { getServerSession } from "@/lib/auth/server-session"
import { hasRole } from "@/utils/roles"
import {
  createSuccess,
  ErrorFactories,
  handleError,
} from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger"
import { revalidateSettingsCache } from "@/lib/settings-manager"
import {
  getOneRosterSettings,
  oneRosterSettingsInputSchema,
  ONEROSTER_SETTING_KEYS,
  type OneRosterSettings,
  type OneRosterSettingsInput,
} from "@/lib/roster/settings"
import {
  getOneRosterSyncOverview,
  listRosterClasses,
  listRosterSchools,
  listRosterStudents,
  type OneRosterSyncOverview,
  type RosterClass,
  type RosterSchool,
  type RosterStudent,
} from "@/lib/roster/queries"
import {
  getOneRosterSyncStatus,
  writeOneRosterSyncStatus,
  type OneRosterSyncStatus,
} from "@/lib/roster/status"
import { triggerOneRosterSyncNow } from "@/lib/roster/trigger"
import type { ActionState } from "@/types"

const ADMIN_ROSTERS_PATH = "/admin/rosters"

export interface OneRosterAdminData {
  settings: OneRosterSettings
  overview: OneRosterSyncOverview
  schools: RosterSchool[]
  syncConfigured: boolean
}

async function requireAdminSession(
  log: ReturnType<typeof createLogger>,
  operation: string
): Promise<string> {
  const session = await getServerSession()
  if (!session) {
    log.warn(`Unauthorized ${operation} attempt`)
    throw ErrorFactories.authNoSession()
  }
  if (!(await hasRole("administrator"))) {
    log.warn(`Non-admin attempted ${operation}`, { userId: session.sub })
    throw ErrorFactories.authzInsufficientPermissions("administrator")
  }
  return session.sub
}

function isConfigured(value: OneRosterSettings): boolean {
  return Boolean(
    value.baseUrl && value.authMode && value.credentialsSecretArn
  )
}

export async function getOneRosterAdminDataAction(): Promise<
  ActionState<OneRosterAdminData>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getOneRosterAdminDataAction")
  const log = createLogger({ requestId, action: "getOneRosterAdminDataAction" })

  try {
    await requireAdminSession(log, "load OneRoster admin data")
    const [rosterSettings, overview, schools] = await Promise.all([
      getOneRosterSettings(),
      getOneRosterSyncOverview(),
      listRosterSchools(),
    ])
    timer({ status: "success" })
    return createSuccess(
      {
        settings: rosterSettings,
        overview,
        schools,
        syncConfigured: isConfigured(rosterSettings),
      },
      "OneRoster admin data loaded"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load OneRoster data.", {
      context: "getOneRosterAdminDataAction",
      requestId,
      operation: "getOneRosterAdminDataAction",
    })
  }
}

export async function saveOneRosterSettingsAction(
  input: OneRosterSettingsInput
): Promise<ActionState<OneRosterSettings>> {
  const requestId = generateRequestId()
  const timer = startTimer("saveOneRosterSettingsAction")
  const log = createLogger({
    requestId,
    action: "saveOneRosterSettingsAction",
  })

  try {
    await requireAdminSession(log, "save OneRoster settings")
    const parsed = oneRosterSettingsInputSchema.parse(input)
    const now = new Date()
    const rows = [
      {
        key: ONEROSTER_SETTING_KEYS.enabled,
        value: String(parsed.enabled),
        description: "Enable scheduled ClassLink OneRoster synchronization",
      },
      {
        key: ONEROSTER_SETTING_KEYS.baseUrl,
        value: parsed.baseUrl,
        description: "ClassLink Roster Server or OAuth2 Proxy base URL",
      },
      {
        key: ONEROSTER_SETTING_KEYS.authMode,
        value: parsed.authMode,
        description: "ClassLink authentication mode: oauth1 or proxy",
      },
      {
        key: ONEROSTER_SETTING_KEYS.credentialsSecretArn,
        value: parsed.credentialsSecretArn,
        description: "Secrets Manager ARN containing ClassLink credentials",
      },
      {
        key: ONEROSTER_SETTING_KEYS.apiVersion,
        value: parsed.apiVersion,
        description: "OneRoster REST API path version",
      },
      {
        key: ONEROSTER_SETTING_KEYS.pageSize,
        value: String(parsed.pageSize),
        description: "OneRoster bulk collection page size",
      },
    ] as const

    await executeTransaction(
      async tx => {
        for (const row of rows) {
          await tx
            .insert(settings)
            .values({
              ...row,
              category: "integrations",
              isSecret:
                row.key === ONEROSTER_SETTING_KEYS.credentialsSecretArn,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: settings.key,
              set: {
                value: row.value,
                description: row.description,
                category: "integrations",
                isSecret:
                  row.key === ONEROSTER_SETTING_KEYS.credentialsSecretArn,
                updatedAt: now,
              },
            })
        }
      },
      "saveOneRosterSettingsAction"
    )

    await revalidateSettingsCache()
    revalidatePath(ADMIN_ROSTERS_PATH)
    const saved = await getOneRosterSettings()
    log.info("OneRoster settings saved", {
      enabled: saved.enabled,
      authMode: saved.authMode,
      apiVersion: saved.apiVersion,
      pageSize: saved.pageSize,
      configured: isConfigured(saved),
    })
    timer({ status: "success" })
    return createSuccess(saved, "OneRoster settings saved")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to save OneRoster settings.", {
      context: "saveOneRosterSettingsAction",
      requestId,
      operation: "saveOneRosterSettingsAction",
    })
  }
}

export async function triggerOneRosterSyncAction(): Promise<
  ActionState<{ runId: string; dispatched: boolean }>
> {
  const requestId = generateRequestId()
  const timer = startTimer("triggerOneRosterSyncAction")
  const log = createLogger({ requestId, action: "triggerOneRosterSyncAction" })
  const runId = randomUUID()
  const startedAt = new Date().toISOString()

  try {
    const cognitoSub = await requireAdminSession(log, "trigger OneRoster sync")
    const rosterSettings = await getOneRosterSettings()
    if (!isConfigured(rosterSettings)) {
      throw ErrorFactories.invalidInput(
        "OneRoster settings",
        "incomplete",
        "Save a base URL, authentication mode, and credentials secret ARN first"
      )
    }

    const queued: OneRosterSyncStatus = {
      runId,
      trigger: "manual",
      state: "queued",
      startedAt,
      completedAt: null,
      unchanged: false,
      collections: [],
      error: null,
    }
    await writeOneRosterSyncStatus(queued)

    const dbUserId = await getUserIdByCognitoSubAsNumber(cognitoSub)
    try {
      await triggerOneRosterSyncNow(dbUserId, runId)
    } catch (error) {
      await writeOneRosterSyncStatus({
        ...queued,
        state: "failed",
        completedAt: new Date().toISOString(),
        error: "The OneRoster sync Lambda could not be invoked.",
      })
      throw error
    }

    log.info("OneRoster sync dispatched", {
      userId: cognitoSub,
      dbUserId,
      runId,
    })
    timer({ status: "success" })
    return createSuccess(
      { runId, dispatched: true },
      "OneRoster sync started"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to start OneRoster sync.", {
      context: "triggerOneRosterSyncAction",
      requestId,
      operation: "triggerOneRosterSyncAction",
    })
  }
}

export async function getOneRosterSyncStatusAction(): Promise<
  ActionState<OneRosterSyncStatus | null>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getOneRosterSyncStatusAction")
  const log = createLogger({
    requestId,
    action: "getOneRosterSyncStatusAction",
  })

  try {
    await requireAdminSession(log, "poll OneRoster sync status")
    const status = await getOneRosterSyncStatus()
    timer({ status: "success" })
    return createSuccess(status, "OneRoster sync status loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load OneRoster sync status.", {
      context: "getOneRosterSyncStatusAction",
      requestId,
      operation: "getOneRosterSyncStatusAction",
    })
  }
}

export async function listRosterClassesAction(
  schoolSourcedId: string
): Promise<ActionState<RosterClass[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("listRosterClassesAction")
  const log = createLogger({ requestId, action: "listRosterClassesAction" })

  try {
    await requireAdminSession(log, "list OneRoster classes")
    if (!schoolSourcedId.trim()) {
      throw ErrorFactories.missingRequiredField("schoolSourcedId")
    }
    const classes = await listRosterClasses(schoolSourcedId)
    timer({ status: "success" })
    return createSuccess(classes, "OneRoster classes loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load OneRoster classes.", {
      context: "listRosterClassesAction",
      requestId,
      operation: "listRosterClassesAction",
    })
  }
}

export async function listRosterStudentsAction(
  classSourcedId: string
): Promise<ActionState<RosterStudent[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("listRosterStudentsAction")
  const log = createLogger({ requestId, action: "listRosterStudentsAction" })

  try {
    await requireAdminSession(log, "list OneRoster students")
    if (!classSourcedId.trim()) {
      throw ErrorFactories.missingRequiredField("classSourcedId")
    }
    const students = await listRosterStudents(classSourcedId)
    timer({ status: "success" })
    return createSuccess(students, "OneRoster students loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load OneRoster students.", {
      context: "listRosterStudentsAction",
      requestId,
      operation: "listRosterStudentsAction",
    })
  }
}
