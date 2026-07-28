"use client"

import { useState, useEffect, useRef } from "react"
import type { Dispatch, SetStateAction } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatDate } from "@/lib/date-utils"
import { UserAvatar } from "./user-avatar"
import { RoleBadgeList } from "./role-badge"
import { StatusIndicator, type UserStatus } from "./status-indicator"
import { cn } from "@/lib/utils"
import {
  IconUser,
  IconKey,
  IconChartBar,
  IconHistory,
  IconEdit,
  IconDeviceFloppy,
  IconX,
} from "@tabler/icons-react"

// User detail type with extended activity info
export interface UserDetail {
  id: number
  firstName: string
  lastName: string
  email: string
  avatarUrl?: string | null
  roles: string[]
  status: UserStatus
  lastSignInAt?: string | null
  createdAt?: string | null
  // Activity summary
  activitySummary?: {
    promptsUsed?: number
    nexusConversations?: number
    lastActivity?: string
  }
}

// Model access configuration
interface ModelAccess {
  id: string
  name: string
  provider: string
  enabled: boolean
}

// Activity log entry
interface ActivityLogEntry {
  id: string
  type: "login" | "assistant" | "prompt" | "nexus" | "settings"
  description: string
  timestamp: string
  metadata?: Record<string, unknown>
}

interface UserDetailSheetProps {
  user: UserDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave?: (user: UserDetail) => Promise<void>
  roles: Array<{ id: string; name: string }>
  modelAccess?: ModelAccess[]
  activityLog?: ActivityLogEntry[]
  loadingActivity?: boolean
  className?: string
}

// Activity type badge
function ActivityTypeBadge({ type }: { type: ActivityLogEntry["type"] }) {
  const config: Record<ActivityLogEntry["type"], { label: string; className: string }> = {
    login: { label: "Login", className: "bg-blue-100 text-blue-800" },
    assistant: { label: "Assistant", className: "bg-purple-100 text-purple-800" },
    prompt: { label: "Prompt", className: "bg-green-100 text-green-800" },
    nexus: { label: "Nexus", className: "bg-orange-100 text-orange-800" },
    settings: { label: "Settings", className: "bg-gray-100 text-gray-800" },
  }

  const { label, className } = config[type]

  return (
    <Badge variant="secondary" className={cn("text-xs", className)}>
      {label}
    </Badge>
  )
}

function UserDetailHeader({
  isEditing,
  isSaving,
  user,
  onCancel,
  onEdit,
  onSave,
}: {
  isEditing: boolean
  isSaving: boolean
  user: UserDetail
  onCancel: () => void
  onEdit: () => void
  onSave: () => void
}) {
  return (
    <DialogHeader className="px-6 py-4 border-b">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <UserAvatar
            firstName={user.firstName}
            lastName={user.lastName}
            email={user.email}
            avatarUrl={user.avatarUrl}
            status={user.status}
            size="lg"
            showStatusIndicator
          />
          <div>
            <DialogTitle className="text-xl">
              {user.firstName} {user.lastName}
            </DialogTitle>
            <DialogDescription className="text-sm">
              {user.email}
            </DialogDescription>
            <div className="mt-1">
              <RoleBadgeList roles={user.roles} maxDisplay={3} />
            </div>
          </div>
        </div>
        {isEditing ? (
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={isSaving}
            >
              <IconX className="h-4 w-4 mr-2" />
              Cancel
            </Button>
            <Button size="sm" onClick={onSave} disabled={isSaving}>
              <IconDeviceFloppy className="h-4 w-4 mr-2" />
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <IconEdit className="h-4 w-4 mr-2" />
            Edit
          </Button>
        )}
      </div>
    </DialogHeader>
  )
}

function UserOverviewTab({
  editedUser,
  isEditing,
  roles,
  user,
  setEditedUser,
}: {
  editedUser: UserDetail | null
  isEditing: boolean
  roles: Array<{ id: string; name: string }>
  user: UserDetail
  setEditedUser: Dispatch<SetStateAction<UserDetail | null>>
}) {
  return (
    <TabsContent value="overview" className="px-6 py-4 mt-0">
      <div className="space-y-6">
        <section>
          <h3 className="text-sm font-medium mb-4">Personal Information</h3>
          <div className="grid grid-cols-2 gap-4">
            {(["firstName", "lastName"] as const).map(fieldName => (
              <div key={fieldName} className="space-y-2">
                <Label htmlFor={fieldName}>
                  {fieldName === "firstName" ? "First Name" : "Last Name"}
                </Label>
                <Input
                  id={fieldName}
                  value={editedUser?.[fieldName] || ""}
                  onChange={event =>
                    setEditedUser(previous =>
                      previous
                        ? { ...previous, [fieldName]: event.target.value }
                        : null
                    )
                  }
                  disabled={!isEditing}
                />
              </div>
            ))}
            <div className="space-y-2 col-span-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                value={user.email}
                disabled
                className="bg-muted"
              />
            </div>
          </div>
        </section>
        <Separator />
        <section>
          <h3 className="text-sm font-medium mb-4">Account Status</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Status</Label>
              <div className="h-9 flex items-center">
                <StatusIndicator status={user.status} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Access Level</Label>
              <Select
                value={editedUser?.roles?.[0] || "student"}
                onValueChange={value =>
                  setEditedUser(previous =>
                    previous ? { ...previous, roles: [value] } : null
                  )
                }
                disabled={!isEditing}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map(role => (
                    <SelectItem key={role.id} value={role.name}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Member Since</Label>
              <p className="text-sm text-muted-foreground h-9 flex items-center">
                {formatDate(user.createdAt)}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Last Sign In</Label>
              <p className="text-sm text-muted-foreground h-9 flex items-center">
                {formatDate(user.lastSignInAt, true)}
              </p>
            </div>
          </div>
        </section>
      </div>
    </TabsContent>
  )
}

function UserPermissionsTab({
  isEditing,
  modelAccess,
  onModelToggle,
}: {
  isEditing: boolean
  modelAccess: ModelAccess[]
  onModelToggle: (modelId: string, enabled: boolean) => void
}) {
  return (
    <TabsContent value="permissions" className="px-6 py-4 mt-0">
      <div className="space-y-6">
        <section>
          <h3 className="text-sm font-medium mb-4">Model Access</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Configure which AI models this user can access
          </p>
          <div className="space-y-3">
            {modelAccess.length > 0 ? (
              modelAccess.map(model => (
                <div
                  key={model.id}
                  className="flex items-center justify-between py-2 px-3 rounded-lg border"
                >
                  <div>
                    <p className="text-sm font-medium">{model.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {model.provider}
                    </p>
                  </div>
                  <Switch
                    checked={model.enabled}
                    onCheckedChange={checked =>
                      onModelToggle(model.id, checked)
                    }
                    disabled={!isEditing}
                  />
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Model access configuration will be available in a future
                update.
              </p>
            )}
          </div>
        </section>
        <Separator />
        <section>
          <h3 className="text-sm font-medium mb-4">Tool Access</h3>
          <p className="text-sm text-muted-foreground py-4 text-center">
            Tool-level permissions are managed through roles.
          </p>
        </section>
      </div>
    </TabsContent>
  )
}

function UserUsageTab({ user }: { user: UserDetail }) {
  return (
    <TabsContent value="usage" className="px-6 py-4 mt-0">
      <div className="space-y-6">
        <section>
          <h3 className="text-sm font-medium mb-4">Usage Summary</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 rounded-lg border bg-muted/50">
              <p className="text-2xl font-bold">
                {user.activitySummary?.promptsUsed ?? 0}
              </p>
              <p className="text-sm text-muted-foreground">Prompts Used</p>
            </div>
            <div className="p-4 rounded-lg border bg-muted/50">
              <p className="text-2xl font-bold">
                {user.activitySummary?.nexusConversations ?? 0}
              </p>
              <p className="text-sm text-muted-foreground">
                Nexus Conversations
              </p>
            </div>
            <div className="p-4 rounded-lg border bg-muted/50 col-span-2">
              <p className="text-sm font-medium">
                {user.activitySummary?.lastActivity
                  ? formatDate(user.activitySummary.lastActivity, true)
                  : "No activity"}
              </p>
              <p className="text-sm text-muted-foreground">Last Activity</p>
            </div>
          </div>
        </section>
        <Separator />
        <section>
          <h3 className="text-sm font-medium mb-4">Token Usage</h3>
          <p className="text-sm text-muted-foreground py-4 text-center">
            Detailed token usage tracking will be available in a future update.
          </p>
        </section>
      </div>
    </TabsContent>
  )
}

function UserActivityTab({
  activityLog,
  loadingActivity,
}: {
  activityLog: ActivityLogEntry[]
  loadingActivity: boolean
}) {
  return (
    <TabsContent value="activity" className="px-6 py-4 mt-0">
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Recent Activity</h3>
        {loadingActivity ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex gap-3">
                <Skeleton className="h-6 w-16" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : activityLog.length > 0 ? (
          <div className="space-y-3">
            {activityLog.map(entry => (
              <div
                key={entry.id}
                className="flex items-start gap-3 py-2 border-b last:border-0"
              >
                <ActivityTypeBadge type={entry.type} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{entry.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(entry.timestamp, true)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No activity recorded for this user.
          </p>
        )}
      </div>
    </TabsContent>
  )
}

export function UserDetailSheet({
  user,
  open,
  onOpenChange,
  onSave,
  roles,
  modelAccess = [],
  activityLog = [],
  loadingActivity = false,
  className,
}: UserDetailSheetProps) {
  const [activeTab, setActiveTab] = useState("overview")
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [editedUser, setEditedUser] = useState<UserDetail | null>(null)
  const [localModelAccess, setLocalModelAccess] = useState<ModelAccess[]>(modelAccess)
  const loadedUserIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (user && loadedUserIdRef.current !== user.id) {
      loadedUserIdRef.current = user.id
      setEditedUser({ ...user })
      setLocalModelAccess(modelAccess)
      setIsEditing(false)
    }
  }, [modelAccess, user])

  const handleSave = async () => {
    if (!editedUser || !onSave) return

    setIsSaving(true)
    try {
      await onSave(editedUser)
      setIsEditing(false) // Only exit edit mode on success
    } catch {
      // Keep editing mode active on error so user can retry
      // Error is already handled by parent component with toast notification
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    if (user) {
      setEditedUser({ ...user })
    }
    setIsEditing(false)
  }

  const handleModelToggle = (modelId: string, enabled: boolean) => {
    setLocalModelAccess((prev) =>
      prev.map((m) => (m.id === modelId ? { ...m, enabled } : m))
    )
  }

  if (!user) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("w-[90vw] h-[90vh] max-w-[90vw] flex flex-col p-0", className)}>
        <UserDetailHeader
          isEditing={isEditing}
          isSaving={isSaving}
          user={user}
          onCancel={handleCancel}
          onEdit={() => setIsEditing(true)}
          onSave={() => void handleSave()}
        />
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
          <TabsList className="mx-6 mt-4 grid w-auto grid-cols-4 bg-muted">
            <TabsTrigger value="overview" className="gap-2">
              <IconUser className="h-4 w-4" />
              <span className="hidden sm:inline">Overview</span>
            </TabsTrigger>
            <TabsTrigger value="permissions" className="gap-2">
              <IconKey className="h-4 w-4" />
              <span className="hidden sm:inline">Permissions</span>
            </TabsTrigger>
            <TabsTrigger value="usage" className="gap-2">
              <IconChartBar className="h-4 w-4" />
              <span className="hidden sm:inline">API Usage</span>
            </TabsTrigger>
            <TabsTrigger value="activity" className="gap-2">
              <IconHistory className="h-4 w-4" />
              <span className="hidden sm:inline">Activity</span>
            </TabsTrigger>
          </TabsList>

          <ScrollArea className="flex-1">
            <UserOverviewTab
              editedUser={editedUser}
              isEditing={isEditing}
              roles={roles}
              user={user}
              setEditedUser={setEditedUser}
            />
            <UserPermissionsTab
              isEditing={isEditing}
              modelAccess={localModelAccess}
              onModelToggle={handleModelToggle}
            />
            <UserUsageTab user={user} />
            <UserActivityTab
              activityLog={activityLog}
              loadingActivity={loadingActivity}
            />
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
