"use client"

import {
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, RefreshCw, Save, Users } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { useToast } from "@/components/ui/use-toast"
import {
  getOneRosterSyncStatusAction,
  listRosterClassesAction,
  listRosterStudentsAction,
  saveOneRosterSettingsAction,
  triggerOneRosterSyncAction,
  type OneRosterAdminData,
} from "@/actions/db/roster-admin-actions"
import type {
  RosterClass,
  RosterStudent,
} from "@/lib/roster/queries"
import type {
  OneRosterAuthMode,
  OneRosterApiVersion,
} from "@/lib/roster/settings"
import type { OneRosterSyncStatus } from "@/lib/roster/status"

type DateValue = Date | string | null

function formatDate(value: DateValue): string {
  if (!value) return "Never"
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? "Never" : parsed.toLocaleString()
}

function displayName(student: RosterStudent): string {
  const name = [student.givenName, student.familyName].filter(Boolean).join(" ")
  return name || student.email || student.userSourcedId || "Unknown student"
}

function collectionLabel(value: string): string {
  const labels: Record<string, string> = {
    orgs: "Organizations",
    academicSessions: "Academic sessions",
    courses: "Courses",
    classes: "Classes",
    users: "Users",
    enrollments: "Enrollments",
  }
  return labels[value] ?? value
}

function statusLabel(status: OneRosterSyncStatus | null): string {
  if (!status) return "No run recorded"
  if (status.state === "succeeded" && status.unchanged) return "No changes"
  return status.state.charAt(0).toUpperCase() + status.state.slice(1)
}

function isTerminal(status: OneRosterSyncStatus): boolean {
  return (
    status.state === "succeeded" ||
    status.state === "failed" ||
    status.state === "skipped"
  )
}

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

async function pollForRun(
  runId: string,
  isMounted: () => boolean
): Promise<OneRosterSyncStatus | null> {
  const deadline = Date.now() + 180_000
  while (isMounted() && Date.now() < deadline) {
    await wait(3_000)
    if (!isMounted()) return null
    const result = await getOneRosterSyncStatusAction()
    const status = result.isSuccess ? result.data : null
    if (status?.runId === runId && isTerminal(status)) return status
  }
  return null
}

interface RostersAdminProps {
  initialData: OneRosterAdminData | null
  initialError: string | null
}

export function RostersAdmin({
  initialData,
  initialError,
}: RostersAdminProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [isSyncing, setIsSyncing] = useState(
    initialData?.overview.status?.state === "queued" ||
      initialData?.overview.status?.state === "running"
  )
  const syncInFlightRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  if (!initialData) {
    return (
      <Alert variant="destructive" data-testid="rosters-load-error">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          {initialError ?? "Failed to load OneRoster data."}
        </AlertDescription>
      </Alert>
    )
  }

  const handleSyncNow = async () => {
    if (syncInFlightRef.current) return
    syncInFlightRef.current = true
    setIsSyncing(true)

    const trigger = await triggerOneRosterSyncAction()
    if (!mountedRef.current) return
    if (!trigger.isSuccess) {
      syncInFlightRef.current = false
      setIsSyncing(false)
      toast({
        title: "Sync could not start",
        description: trigger.message,
        variant: "destructive",
      })
      return
    }

    toast({
      title: "Sync started",
      description: "ClassLink collections are being refreshed.",
    })
    const status = await pollForRun(
      trigger.data.runId,
      () => mountedRef.current
    )
    if (!mountedRef.current) return
    syncInFlightRef.current = false
    setIsSyncing(false)

    if (!status) {
      toast({
        title: "Sync still running",
        description:
          "The run is taking longer than expected. Refresh to see its latest status.",
      })
    } else if (status.state === "succeeded") {
      toast({
        title: status.unchanged ? "Roster already current" : "Sync complete",
        description: status.unchanged
          ? "ClassLink reported no roster changes."
          : "The complete roster snapshot was refreshed.",
      })
    } else {
      toast({
        title: status.state === "skipped" ? "Sync skipped" : "Sync failed",
        description:
          status.error ??
          "The previous roster snapshot was preserved. Review Lambda alarms and logs.",
        variant: "destructive",
      })
    }
    router.refresh()
  }

  return (
    <div className="space-y-6" data-testid="rosters-admin">
      {!initialData.syncConfigured && (
        <Alert data-testid="rosters-not-configured">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Save the ClassLink base URL, documented authentication mode, and
            scoped Secrets Manager ARN before running a sync.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="settings">
        <TabsList>
          <TabsTrigger value="settings" data-testid="tab-roster-settings">
            Settings
          </TabsTrigger>
          <TabsTrigger value="sync" data-testid="tab-roster-sync">
            Sync
          </TabsTrigger>
          <TabsTrigger value="browser" data-testid="tab-roster-browser">
            Roster browser
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings">
          <SettingsTab
            settings={initialData.settings}
            isPending={isPending}
            startTransition={startTransition}
          />
        </TabsContent>

        <TabsContent value="sync">
          <SyncTab
            data={initialData}
            isPending={isPending}
            isSyncing={isSyncing}
            onSync={handleSyncNow}
            onRefresh={() => startTransition(() => router.refresh())}
          />
        </TabsContent>

        <TabsContent value="browser">
          <RosterBrowser data={initialData} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface SettingsTabProps {
  settings: OneRosterAdminData["settings"]
  isPending: boolean
  startTransition: (callback: () => void) => void
}

function SettingsTab({
  settings,
  isPending,
  startTransition,
}: SettingsTabProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [enabled, setEnabled] = useState(settings.enabled)
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? "")
  const [authMode, setAuthMode] = useState<OneRosterAuthMode | "">(
    settings.authMode ?? ""
  )
  const [secretArn, setSecretArn] = useState(
    settings.credentialsSecretArn ?? ""
  )
  const [apiVersion, setApiVersion] = useState<OneRosterApiVersion>(
    settings.apiVersion
  )
  const [pageSize, setPageSize] = useState(String(settings.pageSize))

  const handleSave = () => {
    if (!authMode) {
      toast({
        title: "Settings not saved",
        description: "Select the documented ClassLink authentication mode.",
        variant: "destructive",
      })
      return
    }
    startTransition(async () => {
      const result = await saveOneRosterSettingsAction({
        enabled,
        baseUrl,
        authMode,
        credentialsSecretArn: secretArn,
        apiVersion,
        pageSize,
      })
      if (result.isSuccess) {
        toast({ title: "Settings saved", description: result.message })
        router.refresh()
      } else {
        toast({
          title: "Settings not saved",
          description: result.message,
          variant: "destructive",
        })
      }
    })
  }

  return (
    <Card data-testid="roster-settings-form">
      <CardHeader>
        <CardTitle>ClassLink connection</CardTitle>
        <CardDescription>
          Credentials stay in Secrets Manager. This page stores only the
          connection URL, documented auth mode, secret ARN, API path version,
          page size, and schedule flag.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between rounded-md border p-4">
          <div>
            <Label htmlFor="roster-enabled">Nightly synchronization</Label>
            <p className="text-sm text-muted-foreground">
              Manual sync remains available while the schedule is disabled.
            </p>
          </div>
          <Switch
            id="roster-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            data-testid="roster-enabled"
          />
        </div>

        <ConnectionSettingsFields
          baseUrl={baseUrl}
          setBaseUrl={setBaseUrl}
          authMode={authMode}
          setAuthMode={setAuthMode}
          secretArn={secretArn}
          setSecretArn={setSecretArn}
          apiVersion={apiVersion}
          setApiVersion={setApiVersion}
          pageSize={pageSize}
          setPageSize={setPageSize}
        />

        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={isPending}
            data-testid="roster-settings-save"
          >
            <Save className="mr-2 h-4 w-4" />
            {isPending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

interface ConnectionSettingsFieldsProps {
  baseUrl: string
  setBaseUrl: (value: string) => void
  authMode: OneRosterAuthMode | ""
  setAuthMode: (value: OneRosterAuthMode) => void
  secretArn: string
  setSecretArn: (value: string) => void
  apiVersion: OneRosterApiVersion
  setApiVersion: (value: OneRosterApiVersion) => void
  pageSize: string
  setPageSize: (value: string) => void
}

function ConnectionSettingsFields({
  baseUrl,
  setBaseUrl,
  authMode,
  setAuthMode,
  secretArn,
  setSecretArn,
  apiVersion,
  setApiVersion,
  pageSize,
  setPageSize,
}: ConnectionSettingsFieldsProps) {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor="roster-base-url">ClassLink base URL</Label>
        <Input
          id="roster-base-url"
          value={baseUrl}
          onChange={event => setBaseUrl(event.target.value)}
          placeholder="https://district.example.org"
          autoComplete="off"
          data-testid="roster-base-url"
        />
      </div>

      <div className="space-y-2">
        <Label>Authentication mode</Label>
        <Select
          value={authMode}
          onValueChange={value => setAuthMode(value as OneRosterAuthMode)}
        >
          <SelectTrigger data-testid="roster-auth-mode">
            <SelectValue placeholder="Select documented mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="oauth1">OAuth1 HMAC direct</SelectItem>
            <SelectItem value="proxy">OAuth2 Proxy bearer</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>OneRoster API path</Label>
        <Select
          value={apiVersion}
          onValueChange={value =>
            setApiVersion(value as OneRosterApiVersion)
          }
        >
          <SelectTrigger data-testid="roster-api-version">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="v1p1">v1p1 (default)</SelectItem>
            <SelectItem value="v1p2">v1p2</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2 md:col-span-2">
        <Label htmlFor="roster-secret-arn">Credentials secret ARN</Label>
        <Input
          id="roster-secret-arn"
          value={secretArn}
          onChange={event => setSecretArn(event.target.value)}
          placeholder="arn:aws:secretsmanager:us-west-2:123456789012:secret:aistudio-dev-oneroster-..."
          autoComplete="off"
          data-testid="roster-secret-arn"
        />
        <p className="text-xs text-muted-foreground">
          Must match the{" "}
          <code>aistudio-{"{environment}"}-oneroster-*</code> secret family. The
          credential value is never stored here.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="roster-page-size">Bulk page size</Label>
        <Input
          id="roster-page-size"
          type="number"
          min={1}
          max={10_000}
          value={pageSize}
          onChange={event => setPageSize(event.target.value)}
          data-testid="roster-page-size"
        />
        <p className="text-xs text-muted-foreground">
          ClassLink&apos;s recommended default is 10,000.
        </p>
      </div>
    </div>
  )
}

interface SyncTabProps {
  data: OneRosterAdminData
  isPending: boolean
  isSyncing: boolean
  onSync: () => void
  onRefresh: () => void
}

function SyncTab({
  data,
  isPending,
  isSyncing,
  onSync,
  onRefresh,
}: SyncTabProps) {
  const status = data.overview.status
  const runCollections = new Map(
    status?.collections.map(collection => [collection.name, collection])
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Last run
            </CardTitle>
          </CardHeader>
          <CardContent data-testid="roster-last-run">
            {formatDate(data.overview.lastRunAt)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge
              variant={status?.state === "failed" ? "destructive" : "secondary"}
              data-testid="roster-sync-status"
            >
              {statusLabel(status)}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Schedule
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={data.settings.enabled ? "default" : "outline"}>
              {data.settings.enabled ? "Nightly enabled" : "Disabled"}
            </Badge>
          </CardContent>
        </Card>
      </div>

      {status?.error && (
        <Alert variant="destructive" data-testid="roster-last-error">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{status.error}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={onRefresh}
          disabled={isPending || isSyncing}
          data-testid="roster-refresh"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
        <Button
          onClick={onSync}
          disabled={
            isPending ||
            isSyncing ||
            !data.syncConfigured
          }
          data-testid="roster-sync-now"
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${isSyncing ? "animate-spin" : ""}`}
          />
          {isSyncing ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Collection snapshot</CardTitle>
          <CardDescription>
            Live active/inactive totals plus counts from the last recorded run.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table data-testid="roster-collection-summary">
            <TableHeader>
              <TableRow>
                <TableHead>Collection</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Inactive</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Last synced</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.overview.collections.map(collection => {
                const run = runCollections.get(collection.name)
                return (
                  <TableRow key={collection.name}>
                    <TableCell className="font-medium">
                      {collectionLabel(collection.name)}
                    </TableCell>
                    <TableCell>{collection.active}</TableCell>
                    <TableCell>{collection.inactive}</TableCell>
                    <TableCell>
                      {run
                        ? `${run.synced} synced · ${run.deactivated} deactivated${
                            run.failed ? " · failed" : ""
                          }`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {formatDate(collection.lastSyncedAt)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function RosterBrowser({ data }: { data: OneRosterAdminData }) {
  const { toast } = useToast()
  const [schoolId, setSchoolId] = useState("")
  const [classes, setClasses] = useState<RosterClass[]>([])
  const [students, setStudents] = useState<RosterStudent[]>([])
  const [selectedClass, setSelectedClass] = useState<RosterClass | null>(null)
  const [loadingClasses, setLoadingClasses] = useState(false)
  const [loadingStudents, setLoadingStudents] = useState(false)

  const handleSchoolChange = async (value: string) => {
    setSchoolId(value)
    setClasses([])
    setStudents([])
    setSelectedClass(null)
    setLoadingClasses(true)
    const result = await listRosterClassesAction(value)
    setLoadingClasses(false)
    if (result.isSuccess) {
      setClasses(result.data)
    } else {
      toast({
        title: "Classes unavailable",
        description: result.message,
        variant: "destructive",
      })
    }
  }

  const handleViewRoster = async (rosterClass: RosterClass) => {
    setSelectedClass(rosterClass)
    setStudents([])
    setLoadingStudents(true)
    const result = await listRosterStudentsAction(rosterClass.sourcedId)
    setLoadingStudents(false)
    if (result.isSuccess) {
      setStudents(result.data)
    } else {
      toast({
        title: "Class roster unavailable",
        description: result.message,
        variant: "destructive",
      })
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Browse the synced roster</CardTitle>
          <CardDescription>
            Select a school, inspect its classes and teachers of record, then
            open a read-only student roster.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-xl space-y-2">
            <Label>School</Label>
            <Select value={schoolId} onValueChange={handleSchoolChange}>
              <SelectTrigger data-testid="roster-school-select">
                <SelectValue placeholder="Select a school" />
              </SelectTrigger>
              <SelectContent>
                {data.schools.map(school => (
                  <SelectItem key={school.sourcedId} value={school.sourcedId}>
                    {school.name ?? school.sourcedId}
                    {school.isActive ? "" : " (inactive)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {data.schools.length === 0 && (
              <p
                className="text-sm text-muted-foreground"
                data-testid="roster-schools-empty"
              >
                No synced schools yet.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {schoolId && (
        <RosterClassesCard
          classes={classes}
          loading={loadingClasses}
          onViewRoster={handleViewRoster}
        />
      )}

      {selectedClass && (
        <RosterStudentsCard
          rosterClass={selectedClass}
          students={students}
          loading={loadingStudents}
        />
      )}
    </div>
  )
}

interface RosterClassesCardProps {
  classes: RosterClass[]
  loading: boolean
  onViewRoster: (rosterClass: RosterClass) => void
}

function RosterClassesCard({
  classes,
  loading,
  onViewRoster,
}: RosterClassesCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Classes</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <p className="p-6 text-sm text-muted-foreground">
            Loading classes…
          </p>
        ) : classes.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            No classes are linked to this school.
          </p>
        ) : (
          <Table data-testid="roster-classes-table">
            <TableHeader>
              <TableRow>
                <TableHead>Class</TableHead>
                <TableHead>Term</TableHead>
                <TableHead>Teacher of record</TableHead>
                <TableHead>Students</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Roster</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {classes.map(rosterClass => (
                <TableRow
                  key={rosterClass.sourcedId}
                  data-testid={`roster-class-${rosterClass.sourcedId}`}
                >
                  <TableCell>
                    <div className="font-medium">
                      {rosterClass.title ?? rosterClass.sourcedId}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {rosterClass.classCode ?? rosterClass.location ?? ""}
                    </div>
                  </TableCell>
                  <TableCell>{rosterClass.terms.join(", ") || "—"}</TableCell>
                  <TableCell>
                    {rosterClass.teachers.join(", ") || "—"}
                  </TableCell>
                  <TableCell>{rosterClass.studentCount}</TableCell>
                  <TableCell>
                    <Badge
                      variant={rosterClass.isActive ? "default" : "secondary"}
                    >
                      {rosterClass.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onViewRoster(rosterClass)}
                      data-testid={`view-roster-${rosterClass.sourcedId}`}
                    >
                      <Users className="mr-2 h-4 w-4" />
                      View
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

interface RosterStudentsCardProps {
  rosterClass: RosterClass
  students: RosterStudent[]
  loading: boolean
}

function RosterStudentsCard({
  rosterClass,
  students,
  loading,
}: RosterStudentsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {rosterClass.title ?? rosterClass.sourcedId} roster
        </CardTitle>
        <CardDescription>
          Student enrollment and user status are shown separately so
          referential or deactivation drift is visible.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <p className="p-6 text-sm text-muted-foreground">
            Loading students…
          </p>
        ) : students.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            No student enrollments are present for this class.
          </p>
        ) : (
          <RosterStudentsTable students={students} />
        )}
      </CardContent>
    </Card>
  )
}

function RosterStudentsTable({
  students,
}: {
  students: RosterStudent[]
}) {
  return (
    <Table data-testid="roster-students-table">
      <TableHeader>
        <TableRow>
          <TableHead>Student</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Primary</TableHead>
          <TableHead>Enrollment</TableHead>
          <TableHead>User</TableHead>
          <TableHead>Last synced</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {students.map(student => (
          <TableRow key={student.enrollmentSourcedId}>
            <TableCell className="font-medium">
              {displayName(student)}
            </TableCell>
            <TableCell>{student.email ?? "—"}</TableCell>
            <TableCell>{student.isPrimary ? "Yes" : "No"}</TableCell>
            <TableCell>
              <Badge
                variant={student.enrollmentActive ? "default" : "secondary"}
              >
                {student.enrollmentActive ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge
                variant={
                  student.userActive === false ? "secondary" : "default"
                }
              >
                {student.userActive === null
                  ? "Missing"
                  : student.userActive
                    ? "Active"
                    : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>{formatDate(student.lastSyncedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
