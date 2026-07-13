"use client"

/**
 * Group-sync admin client (Epic #1202, Phase 0 / #1203).
 *
 * Interactive surface over the group-sync server actions: selection-rule CRUD
 * (hand-picked emails + prefix rules), sync status, a read-only group/member
 * browser, and the manual "Sync now" trigger. Reads never mutate group_members —
 * that table is owned by the sync Lambda. Split into focused sub-components
 * (shell / selection tab / groups tab / member dialog) to keep each small.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/components/ui/use-toast"
import { AlertCircle, RefreshCw, Trash2, Users } from "lucide-react"
import {
  addSelectionRuleAction,
  deleteSelectionRuleAction,
  setSelectionRuleActiveAction,
  triggerGroupSyncAction,
  getGroupSyncSummaryAction,
  listGroupMembersAction,
  addGroupRoleMappingAction,
  deleteGroupRoleMappingAction,
  type GroupsAdminData,
  type RoleOption,
} from "@/actions/db/groups-actions"
import type {
  GroupSelectionRuleRow,
  GroupSelectionRuleType,
} from "@/lib/db/schema"
import type { GroupWithCount, GroupRoleMappingView } from "@/lib/groups/queries"
import { timeAgo } from "@/lib/atrium/relative-time"

type ToastFn = ReturnType<typeof useToast>["toast"]

function formatDate(value: Date | string | null): string {
  if (!value) return "Never"
  const d = typeof value === "string" ? new Date(value) : value
  return Number.isNaN(d.getTime()) ? "Never" : d.toLocaleString()
}

/** Epoch millis for a Date|string|null, 0 when absent/invalid (poll comparison). */
function toMillis(value: Date | string | null | undefined): number {
  if (!value) return 0
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}

/** ISO string for the relative-time formatter, or null when absent. */
function toIso(value: Date | string | null): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : value
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Shared action-runner for the tab components: wraps a server action in the
 * page transition, toasts success (optional title) or failure, and refreshes
 * the page data on success. One behavior to maintain across tabs.
 */
function makeActionRunner(
  startTransition: (cb: () => void) => void,
  toast: ToastFn,
  onChanged: () => void
) {
  return (
    fn: () => Promise<{ isSuccess: boolean; message: string }>,
    okTitle?: string
  ) => {
    startTransition(async () => {
      const result = await fn()
      if (result.isSuccess) {
        if (okTitle) toast({ title: okTitle, description: result.message })
        onChanged()
      } else {
        toast({ title: "Error", description: result.message, variant: "destructive" })
      }
    })
  }
}

interface GroupsAdminProps {
  initialData: GroupsAdminData | null
  initialError: string | null
}

export function GroupsAdmin({ initialData, initialError }: GroupsAdminProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  // Separate from isPending: the sync is an async Lambda we poll for, not a
  // server-action transition — the button stays "Syncing…" across the poll loop.
  const [isSyncing, setIsSyncing] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = () => startTransition(() => router.refresh())

  const lastRunAt = initialData?.summary.lastRunAt ?? null

  const handleSyncNow = async () => {
    // Set BEFORE the trigger round trip: a second click during the server-action
    // await must not dispatch a second Lambda invocation (#1204 review).
    if (isSyncing) return
    setIsSyncing(true)
    // Snapshot the current last-run so we can detect when the async run advances it.
    const before = toMillis(lastRunAt)

    const trigger = await triggerGroupSyncAction()
    if (!mountedRef.current) return
    if (!trigger.isSuccess) {
      setIsSyncing(false)
      toast({ title: "Error", description: trigger.message, variant: "destructive" })
      return
    }
    toast({ title: "Sync started", description: "Running the directory sync…" })

    // Poll until the run SETTLES, not merely starts: each group commits its
    // last_synced_at independently mid-run, so "advanced past `before`" fires on
    // the FIRST group of a multi-group run. Only report complete once an
    // advanced last-run holds still for a full poll interval (no group finished
    // in ~4s ⇒ the loop is done or effectively done).
    const deadline = Date.now() + 120_000
    let lastSeen = before
    let advanced = false
    while (mountedRef.current && Date.now() < deadline) {
      await sleep(4000)
      if (!mountedRef.current) return
      const poll = await getGroupSyncSummaryAction()
      if (!poll.isSuccess) continue
      const current = toMillis(poll.data.lastRunAt)
      if (current > lastSeen) {
        advanced = true
        lastSeen = current
        continue
      }
      if (advanced) {
        setIsSyncing(false)
        toast({ title: "Sync complete", description: "Membership refreshed." })
        router.refresh()
        return
      }
    }
    if (mountedRef.current) {
      setIsSyncing(false)
      toast({
        title: "Sync still running",
        description: "Taking longer than usual — showing what has finished so far.",
      })
      // Refresh here too: covers the all-groups-fail run, where last_synced_at
      // never advances but the failed-count banner has data worth surfacing.
      router.refresh()
    }
  }

  if (!initialData) {
    return (
      <Alert variant="destructive" data-testid="groups-load-error">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{initialError ?? "Failed to load group data."}</AlertDescription>
      </Alert>
    )
  }

  const { summary } = initialData

  return (
    <div className="space-y-6" data-testid="groups-admin">
      <ConfigBanners data={initialData} />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard label="Active groups" value={summary.activeGroups} testid="summary-active" />
        <SummaryCard label="Total members" value={summary.totalMembers} testid="summary-members" />
        <SummaryCard
          label="Failed syncs"
          value={summary.failedGroups}
          testid="summary-failed"
          emphasis={summary.failedGroups > 0}
        />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Last run</CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className="text-sm font-medium"
              data-testid="summary-last-run"
              title={formatDate(summary.lastRunAt)}
            >
              {timeAgo(toIso(summary.lastRunAt)) || "Never"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={refresh}
          disabled={isPending || isSyncing}
          data-testid="groups-refresh"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
        <Button onClick={handleSyncNow} disabled={isPending || isSyncing} data-testid="groups-sync-now">
          <RefreshCw className={`mr-2 h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
          {isSyncing ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      <Tabs defaultValue="selection">
        <TabsList>
          <TabsTrigger value="selection" data-testid="tab-selection">
            Selection
          </TabsTrigger>
          <TabsTrigger value="mappings" data-testid="tab-mappings">
            Role mappings
          </TabsTrigger>
          <TabsTrigger value="groups" data-testid="tab-groups">
            Groups &amp; members
          </TabsTrigger>
        </TabsList>

        <TabsContent value="selection" className="space-y-4">
          <SelectionTab
            rules={initialData.rules}
            isPending={isPending}
            toast={toast}
            onChanged={() => router.refresh()}
            startTransition={startTransition}
          />
        </TabsContent>

        <TabsContent value="mappings" className="space-y-4">
          <MappingsTab
            mappings={initialData.mappings}
            groups={initialData.groups}
            roles={initialData.roles}
            isPending={isPending}
            toast={toast}
            onChanged={() => router.refresh()}
            startTransition={startTransition}
          />
        </TabsContent>

        <TabsContent value="groups">
          <GroupsTab
            groups={initialData.groups}
            isPending={isPending}
            toast={toast}
            startTransition={startTransition}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ConfigBanners({ data }: { data: GroupsAdminData }) {
  if (!data.syncConfigured) {
    return (
      <Alert data-testid="groups-not-configured">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          The Google service-account secret is not configured yet. Set{" "}
          <code>GOOGLE_DIRECTORY_SA_SECRET_ARN</code> (and{" "}
          <code>GROUP_SYNC_ENABLED=true</code>) in Admin → Settings to enable the
          hourly sync.
        </AlertDescription>
      </Alert>
    )
  }
  if (!data.syncEnabled) {
    return (
      <Alert data-testid="groups-disabled">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Group sync is configured but disabled. Set{" "}
          <code>GROUP_SYNC_ENABLED=true</code> in Admin → Settings to run the
          hourly schedule. Manual &quot;Sync now&quot; still works.
        </AlertDescription>
      </Alert>
    )
  }
  return null
}

interface SelectionTabProps {
  rules: GroupSelectionRuleRow[]
  isPending: boolean
  toast: ToastFn
  onChanged: () => void
  startTransition: (cb: () => void) => void
}

function SelectionTab({ rules, isPending, toast, onChanged, startTransition }: SelectionTabProps) {
  const [ruleType, setRuleType] = useState<GroupSelectionRuleType>("pick")
  const [ruleValue, setRuleValue] = useState("")

  const run = makeActionRunner(startTransition, toast, onChanged)

  const handleAddRule = () => {
    const value = ruleValue.trim()
    if (!value) {
      toast({ title: "Enter a value", description: "Add a group email or prefix.", variant: "destructive" })
      return
    }
    run(async () => {
      const result = await addSelectionRuleAction(ruleType, value)
      if (result.isSuccess) setRuleValue("")
      return result
    }, "Rule added")
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a selection rule</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select value={ruleType} onValueChange={(v) => setRuleType(v as GroupSelectionRuleType)}>
              <SelectTrigger className="w-full sm:w-40" data-testid="rule-type-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pick">Exact email</SelectItem>
                <SelectItem value="prefix">Email prefix</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={ruleValue}
              onChange={(e) => setRuleValue(e.target.value)}
              placeholder={ruleType === "pick" ? "group@psd401.net" : "staff-"}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddRule()
              }}
              data-testid="rule-value-input"
            />
            <Button onClick={handleAddRule} disabled={isPending} data-testid="rule-add">
              Add
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Exact emails are always synced. A prefix syncs every directory group
            whose email starts with it (e.g. <code>staff-</code>).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Selection rules</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rules.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground" data-testid="rules-empty">
              No selection rules yet. Add an exact email or a prefix above.
            </p>
          ) : (
            <Table data-testid="rules-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id} data-testid={`rule-row-${rule.id}`}>
                    <TableCell>
                      <Badge variant={rule.ruleType === "pick" ? "default" : "secondary"}>
                        {rule.ruleType === "pick" ? "Email" : "Prefix"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{rule.value}</TableCell>
                    <TableCell>
                      <Switch
                        checked={rule.isActive}
                        onCheckedChange={(checked) =>
                          run(() => setSelectionRuleActiveAction(rule.id, checked))
                        }
                        disabled={isPending}
                        aria-label="Toggle rule active"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => run(() => deleteSelectionRuleAction(rule.id), "Rule deleted")}
                        disabled={isPending}
                        aria-label="Delete rule"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

interface MappingsTabProps {
  mappings: GroupRoleMappingView[]
  groups: GroupWithCount[]
  roles: RoleOption[]
  isPending: boolean
  toast: ToastFn
  onChanged: () => void
  startTransition: (cb: () => void) => void
}

function MappingsTab({
  mappings,
  groups,
  roles,
  isPending,
  toast,
  onChanged,
  startTransition,
}: MappingsTabProps) {
  const [groupEmail, setGroupEmail] = useState("")
  const [roleId, setRoleId] = useState("")

  // Group picker options: every synced group, alphabetical by email.
  const groupOptions = useMemo(
    () => [...groups].sort((a, b) => a.groupEmail.localeCompare(b.groupEmail)),
    [groups]
  )
  const hasGroups = groupOptions.length > 0
  const hasRoles = roles.length > 0

  const run = makeActionRunner(startTransition, toast, onChanged)

  const handleAdd = () => {
    if (!groupEmail) {
      toast({ title: "Pick a group", description: "Choose a synced group.", variant: "destructive" })
      return
    }
    if (!roleId) {
      toast({ title: "Pick a role", description: "Choose a role to grant.", variant: "destructive" })
      return
    }
    run(async () => {
      const result = await addGroupRoleMappingAction(groupEmail, Number(roleId))
      if (result.isSuccess) {
        setGroupEmail("")
        setRoleId("")
      }
      return result
    }, "Mapping added")
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a role mapping</CardTitle>
        </CardHeader>
        <CardContent>
          {!hasGroups ? (
            <p className="text-sm text-muted-foreground" data-testid="mappings-no-groups">
              No synced groups yet. Add a selection rule and run &quot;Sync now&quot;
              before mapping a group to a role.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select value={groupEmail} onValueChange={setGroupEmail}>
                  <SelectTrigger className="w-full sm:w-72" data-testid="mapping-group-select">
                    <SelectValue placeholder="Select a group" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupOptions.map((group) => (
                      <SelectItem key={group.id} value={group.groupEmail}>
                        {group.groupEmail}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={roleId} onValueChange={setRoleId}>
                  <SelectTrigger className="w-full sm:w-48" data-testid="mapping-role-select">
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((role) => (
                      <SelectItem key={role.id} value={String(role.id)}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={handleAdd}
                  disabled={isPending || !hasRoles}
                  data-testid="mapping-add"
                >
                  Add
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Every member of the group is granted the role on the next sync or
                login. Removing a mapping revokes only sync-managed grants — roles
                assigned by hand are never touched.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <MappingsList
        mappings={mappings}
        isPending={isPending}
        onDelete={(id) => run(() => deleteGroupRoleMappingAction(id), "Mapping deleted")}
      />
    </div>
  )
}

/** The existing-mappings table (extracted to keep MappingsTab small). */
function MappingsList({
  mappings,
  isPending,
  onDelete,
}: {
  mappings: GroupRoleMappingView[]
  isPending: boolean
  onDelete: (id: string) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Role mappings</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {mappings.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground" data-testid="mappings-empty">
            No role mappings yet. Map a synced group to a role above.
          </p>
        ) : (
          <Table data-testid="mappings-table">
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappings.map((mapping) => (
                <TableRow key={mapping.id} data-testid={`mapping-row-${mapping.id}`}>
                  <TableCell className="font-mono text-sm break-all">{mapping.groupEmail}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{mapping.roleName}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDelete(mapping.id)}
                      disabled={isPending}
                      aria-label="Delete mapping"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

interface GroupsTabProps {
  groups: GroupWithCount[]
  isPending: boolean
  toast: ToastFn
  startTransition: (cb: () => void) => void
}

function GroupsTab({ groups, isPending, toast, startTransition }: GroupsTabProps) {
  const [memberDialog, setMemberDialog] = useState<{
    groupEmail: string
    members: string[] | null
  } | null>(null)

  const openMembers = (groupId: string, groupEmail: string) => {
    setMemberDialog({ groupEmail, members: null })
    startTransition(async () => {
      const result = await listGroupMembersAction(groupId)
      // Guard against out-of-order responses: only apply if the dialog is still
      // showing THIS group (the admin may have closed it or opened another).
      if (!result.isSuccess) {
        setMemberDialog((current) => (current?.groupEmail === groupEmail ? null : current))
        toast({ title: "Error", description: result.message, variant: "destructive" })
        return
      }
      setMemberDialog((current) =>
        current?.groupEmail === groupEmail ? { groupEmail, members: result.data } : current
      )
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Synced groups</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {groups.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground" data-testid="groups-empty">
            No groups synced yet. Add a selection rule and run &quot;Sync now&quot;.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="groups-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Group</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead>Last synced</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Browse</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <GroupRow key={group.id} group={group} isPending={isPending} onBrowse={openMembers} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      <MemberDialog dialog={memberDialog} onClose={() => setMemberDialog(null)} />
    </Card>
  )
}

function GroupRow({
  group,
  isPending,
  onBrowse,
}: {
  group: GroupWithCount
  isPending: boolean
  onBrowse: (groupId: string, groupEmail: string) => void
}) {
  return (
    <TableRow data-testid={`group-row-${group.id}`} className={group.isActive ? "" : "opacity-60"}>
      <TableCell>
        <div className="font-mono text-sm">{group.groupEmail}</div>
        {group.name && <div className="text-xs text-muted-foreground">{group.name}</div>}
      </TableCell>
      <TableCell>
        <Badge variant={group.source === "manual" ? "default" : "secondary"}>
          {group.source === "manual" ? "Email" : "Prefix"}
        </Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums" data-testid={`group-count-${group.id}`}>
        {group.memberCount}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{formatDate(group.lastSyncedAt)}</TableCell>
      <TableCell>
        {group.lastSyncError ? (
          <Badge variant="destructive" title={group.lastSyncError}>
            Failed
          </Badge>
        ) : !group.isActive ? (
          <Badge variant="outline">Inactive</Badge>
        ) : (
          <Badge variant="secondary">OK</Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onBrowse(group.id, group.groupEmail)}
          disabled={isPending}
          aria-label="Browse members"
        >
          <Users className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  )
}

function MemberDialog({
  dialog,
  onClose,
}: {
  dialog: { groupEmail: string; members: string[] | null } | null
  onClose: () => void
}) {
  return (
    <Dialog open={!!dialog} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm break-all">{dialog?.groupEmail}</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto max-h-[60vh]" data-testid="member-list">
          {dialog?.members === null ? (
            <p className="text-sm text-muted-foreground">Loading members…</p>
          ) : (dialog?.members?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No members.</p>
          ) : (
            <ul className="space-y-1">
              {dialog?.members?.map((email) => (
                <li key={email} className="font-mono text-sm">
                  {email}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SummaryCard({
  label,
  value,
  testid,
  emphasis,
}: {
  label: string
  value: number
  testid: string
  emphasis?: boolean
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p
          className={`text-2xl font-semibold tabular-nums ${emphasis ? "text-destructive" : ""}`}
          data-testid={testid}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  )
}
