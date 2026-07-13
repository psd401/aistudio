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
  listGroupRoleMappings,
  addGroupRoleMapping,
  deleteGroupRoleMapping,
  type GroupWithCount,
  type GroupSyncSummary,
  type GroupRoleMappingView,
} from "@/lib/groups/queries"
import type { GroupSelectionRuleRow, GroupSelectionRuleType } from "@/lib/db/schema"
import { triggerGroupSyncNow } from "@/lib/groups/trigger"
import { getGroupSyncSettings } from "@/lib/groups/settings"
import { getUserIdByCognitoSubAsNumber, getRoles } from "@/lib/db/drizzle"

/** A role option for the mapping role picker. */
export interface RoleOption {
  id: number
  name: string
}

const ADMIN_GROUPS_PATH = "/admin/groups"

/** Combined payload for the admin dashboard's initial render. */
export interface GroupsAdminData {
  summary: GroupSyncSummary
  groups: GroupWithCount[]
  rules: GroupSelectionRuleRow[]
  /** Group→role mappings (#1204) + the roles available to map them to. */
  mappings: GroupRoleMappingView[]
  roles: RoleOption[]
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

    const [summary, groups, rules, mappings, roleRows, settings] = await Promise.all([
      getGroupSyncSummary(),
      listGroupsWithCounts(),
      listSelectionRules(),
      listGroupRoleMappings(),
      getRoles(),
      getGroupSyncSettings(),
    ])

    timer({ status: "success" })
    return createSuccess(
      {
        summary,
        groups,
        rules,
        mappings,
        roles: roleRows.map((r) => ({ id: r.id, name: r.name })),
        syncEnabled: settings.enabled,
        // Runnable = SA key + a directory path: Cloud Identity needs customerId,
        // the Admin SDK fallback needs dwdSubject. The ARN alone would clear the
        // banner while every run still failed in the client constructor.
        syncConfigured: Boolean(
          settings.saSecretArn && (settings.customerId || settings.dwdSubject)
        ),
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
    const cognitoSub = await requireAdminSession(log, "trigger group sync")

    // session.sub is a Cognito UUID, not the numeric users.id — resolve it so
    // the Lambda's audit log can actually record who pressed "Sync now".
    const dbUserId = await getUserIdByCognitoSubAsNumber(cognitoSub)
    await triggerGroupSyncNow(dbUserId)

    log.info("Group sync dispatched", { userId: cognitoSub, dbUserId })
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

/**
 * Lightweight sync-status poll (#1204). The admin UI calls this on an interval
 * after "Sync now" to detect when the async Lambda has finished — the run is done
 * once `lastRunAt` (max groups.last_synced_at) advances past the pre-trigger value.
 */
export async function getGroupSyncSummaryAction(): Promise<ActionState<GroupSyncSummary>> {
  const requestId = generateRequestId()
  const timer = startTimer("getGroupSyncSummaryAction")
  const log = createLogger({ requestId, action: "getGroupSyncSummaryAction" })

  try {
    await requireAdminSession(log, "poll group sync summary")
    const summary = await getGroupSyncSummary()
    timer({ status: "success" })
    return createSuccess(summary, "Sync summary loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load sync summary.", {
      context: "getGroupSyncSummaryAction",
      requestId,
      operation: "getGroupSyncSummaryAction",
    })
  }
}

/** Add a group→role mapping — members of the group get the role on next sync/login. */
export async function addGroupRoleMappingAction(
  groupEmail: string,
  roleId: number
): Promise<ActionState<GroupRoleMappingView>> {
  const requestId = generateRequestId()
  const timer = startTimer("addGroupRoleMappingAction")
  const log = createLogger({ requestId, action: "addGroupRoleMappingAction" })

  try {
    await requireAdminSession(log, "add group role mapping")
    if (!groupEmail || !groupEmail.trim()) {
      throw ErrorFactories.missingRequiredField("groupEmail")
    }
    if (!Number.isInteger(roleId) || roleId <= 0) {
      throw ErrorFactories.invalidInput("roleId", roleId, "Select a role")
    }

    log.info("Adding group role mapping", {
      input: sanitizeForLogging({ groupEmail, roleId }),
    })
    const mapping = await addGroupRoleMapping(groupEmail, roleId)

    revalidatePath(ADMIN_GROUPS_PATH)
    timer({ status: "success", mappingId: mapping.id })
    return createSuccess(mapping, "Role mapping added")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to add role mapping.", {
      context: "addGroupRoleMappingAction",
      requestId,
      operation: "addGroupRoleMappingAction",
    })
  }
}

/** Delete a group→role mapping — sync-managed grants of that role are removed next run. */
export async function deleteGroupRoleMappingAction(id: string): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteGroupRoleMappingAction")
  const log = createLogger({ requestId, action: "deleteGroupRoleMappingAction" })

  try {
    await requireAdminSession(log, "delete group role mapping")
    if (!id) throw ErrorFactories.missingRequiredField("id")

    await deleteGroupRoleMapping(id)
    revalidatePath(ADMIN_GROUPS_PATH)
    timer({ status: "success" })
    return createSuccess(undefined, "Role mapping deleted")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete role mapping.", {
      context: "deleteGroupRoleMappingAction",
      requestId,
      operation: "deleteGroupRoleMappingAction",
    })
  }
}
