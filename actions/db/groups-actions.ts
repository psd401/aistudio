"use server"

/**
 * Group-sync admin server actions (Epic #1202, Phase 0 / #1203).
 *
 * Back the /admin/groups UI: selection-rule CRUD, sync status + group/member
 * browser reads, and the manual "Sync now" trigger. Every mutating and reading
 * action is administrator-gated (group data is global authorization state).
 * Membership itself is written only by the sync Lambda — these actions never
 * mutate group_members.
 */

import { revalidatePath } from "next/cache"
import { getServerSession } from "@/lib/auth/server-session"
import { hasRole } from "@/utils/roles"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger"
import type { ActionState } from "@/types"
import {
  listGroupsWithCounts,
  listGroupMemberEmails,
  getGroupSyncSummary,
  listSelectionRules,
  addSelectionRule,
  deleteSelectionRule,
  setSelectionRuleActive,
  type GroupWithCount,
  type GroupSyncSummary,
} from "@/lib/groups/queries"
import type { GroupSelectionRuleRow, GroupSelectionRuleType } from "@/lib/db/schema"
import { triggerGroupSyncNow } from "@/lib/groups/trigger"
import { getGroupSyncSettings } from "@/lib/groups/settings"

const ADMIN_GROUPS_PATH = "/admin/groups"

/** Combined payload for the admin dashboard's initial render. */
export interface GroupsAdminData {
  summary: GroupSyncSummary
  groups: GroupWithCount[]
  rules: GroupSelectionRuleRow[]
  /** Whether the hourly sync is enabled + configured (drives a UI banner). */
  syncEnabled: boolean
  syncConfigured: boolean
}

/** Shared admin gate — returns the userId (sub) or throws a typed error. */
async function requireAdminSession(
  log: ReturnType<typeof createLogger>,
  action: string
): Promise<string> {
  const session = await getServerSession()
  if (!session) {
    log.warn(`Unauthorized ${action} attempt`)
    throw ErrorFactories.authNoSession()
  }
  if (!(await hasRole("administrator"))) {
    log.warn(`Non-admin attempted ${action}`, { userId: session.sub })
    throw ErrorFactories.authzInsufficientPermissions("administrator")
  }
  return session.sub
}

/** Load everything the admin dashboard needs in one round-trip. */
export async function getGroupsAdminDataAction(): Promise<ActionState<GroupsAdminData>> {
  const requestId = generateRequestId()
  const timer = startTimer("getGroupsAdminDataAction")
  const log = createLogger({ requestId, action: "getGroupsAdminDataAction" })

  try {
    await requireAdminSession(log, "load group admin data")

    const [summary, groups, rules, settings] = await Promise.all([
      getGroupSyncSummary(),
      listGroupsWithCounts(),
      listSelectionRules(),
      getGroupSyncSettings(),
    ])

    timer({ status: "success" })
    return createSuccess(
      {
        summary,
        groups,
        rules,
        syncEnabled: settings.enabled,
        syncConfigured: Boolean(settings.saSecretArn),
      },
      "Group admin data loaded"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load group data.", {
      context: "getGroupsAdminDataAction",
      requestId,
      operation: "getGroupsAdminDataAction",
    })
  }
}

/** Member emails for one group (read-only browser). */
export async function listGroupMembersAction(
  groupId: string
): Promise<ActionState<string[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("listGroupMembersAction")
  const log = createLogger({ requestId, action: "listGroupMembersAction" })

  try {
    await requireAdminSession(log, "list group members")
    if (!groupId) throw ErrorFactories.missingRequiredField("groupId")

    const members = await listGroupMemberEmails(groupId)
    timer({ status: "success" })
    return createSuccess(members, "Group members loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load group members.", {
      context: "listGroupMembersAction",
      requestId,
      operation: "listGroupMembersAction",
    })
  }
}

/** Add (or reactivate) a selection rule — a hand-picked email or a prefix. */
export async function addSelectionRuleAction(
  ruleType: GroupSelectionRuleType,
  value: string
): Promise<ActionState<GroupSelectionRuleRow>> {
  const requestId = generateRequestId()
  const timer = startTimer("addSelectionRuleAction")
  const log = createLogger({ requestId, action: "addSelectionRuleAction" })

  try {
    await requireAdminSession(log, "add selection rule")
    if (ruleType !== "pick" && ruleType !== "prefix") {
      throw ErrorFactories.invalidInput("ruleType", ruleType, "Must be 'pick' or 'prefix'")
    }
    if (!value || !value.trim()) {
      throw ErrorFactories.missingRequiredField("value")
    }

    log.info("Adding selection rule", { input: sanitizeForLogging({ ruleType, value }) })
    const rule = await addSelectionRule(ruleType, value)

    revalidatePath(ADMIN_GROUPS_PATH)
    timer({ status: "success", ruleId: rule.id })
    return createSuccess(rule, "Selection rule added")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to add selection rule.", {
      context: "addSelectionRuleAction",
      requestId,
      operation: "addSelectionRuleAction",
    })
  }
}

/** Permanently delete a selection rule. */
export async function deleteSelectionRuleAction(id: string): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteSelectionRuleAction")
  const log = createLogger({ requestId, action: "deleteSelectionRuleAction" })

  try {
    await requireAdminSession(log, "delete selection rule")
    if (!id) throw ErrorFactories.missingRequiredField("id")

    await deleteSelectionRule(id)
    revalidatePath(ADMIN_GROUPS_PATH)
    timer({ status: "success" })
    return createSuccess(undefined, "Selection rule deleted")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete selection rule.", {
      context: "deleteSelectionRuleAction",
      requestId,
      operation: "deleteSelectionRuleAction",
    })
  }
}

/** Toggle a selection rule active/inactive without losing its history. */
export async function setSelectionRuleActiveAction(
  id: string,
  isActive: boolean
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("setSelectionRuleActiveAction")
  const log = createLogger({ requestId, action: "setSelectionRuleActiveAction" })

  try {
    await requireAdminSession(log, "toggle selection rule")
    if (!id) throw ErrorFactories.missingRequiredField("id")

    await setSelectionRuleActive(id, isActive)
    revalidatePath(ADMIN_GROUPS_PATH)
    timer({ status: "success" })
    return createSuccess(undefined, isActive ? "Rule enabled" : "Rule disabled")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update selection rule.", {
      context: "setSelectionRuleActiveAction",
      requestId,
      operation: "setSelectionRuleActiveAction",
    })
  }
}

/** Async-invoke the sync Lambda now (same code path as the hourly schedule). */
export async function triggerGroupSyncAction(): Promise<ActionState<{ dispatched: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("triggerGroupSyncAction")
  const log = createLogger({ requestId, action: "triggerGroupSyncAction" })

  try {
    const userId = await requireAdminSession(log, "trigger group sync")

    const numericUserId = Number(userId)
    await triggerGroupSyncNow(Number.isFinite(numericUserId) ? numericUserId : null)

    log.info("Group sync dispatched", { userId })
    timer({ status: "success" })
    return createSuccess({ dispatched: true }, "Sync started — refresh in a minute to see results")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to start sync.", {
      context: "triggerGroupSyncAction",
      requestId,
      operation: "triggerGroupSyncAction",
    })
  }
}
