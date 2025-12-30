"use client"

import { useState, useEffect } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
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
  id: string | number
  firstName: string
  lastName: string
  email: string
  avatarUrl?: string | null
  roles: string[]
  status: UserStatus
  lastSignInAt?: string | null
  createdAt?: string | null
  // Extended fields for detail view
  jobTitle?: string
  organization?: string
  phone?: string
  // Activity summary
  activitySummary?: {
    assistantExecutions?: number
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

// Format date for display
function formatDate(dateString: string | null | undefined, includeTime = false): string {
  if (!dateString) return "Never"

  const utcString = dateString.includes("Z") || dateString.includes("+")
    ? dateString
    : dateString + "Z"

  const date = new Date(utcString)

  if (includeTime) {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
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

  // Reset state when user changes
  useEffect(() => {
    if (user) {
      setEditedUser({ ...user })
      setLocalModelAccess(modelAccess)
    }
    setIsEditing(false)
  }, [user, modelAccess])

  const handleSave = async () => {
    if (!editedUser || !onSave) return

    setIsSaving(true)
    try {
      await onSave(editedUser)
      setIsEditing(false)
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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="lg" className={cn("flex flex-col p-0", className)}>
        {/* Header */}
        <SheetHeader className="px-6 py-4 border-b">
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
                <SheetTitle className="text-xl">
                  {user.firstName} {user.lastName}
                </SheetTitle>
                <SheetDescription className="text-sm">{user.email}</SheetDescription>
                <div className="mt-1">
                  <RoleBadgeList roles={user.roles} maxDisplay={3} />
                </div>
              </div>
            </div>
            {!isEditing ? (
              <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                <IconEdit className="h-4 w-4 mr-2" />
                Edit
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isSaving}>
                  <IconX className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={isSaving}>
                  <IconDeviceFloppy className="h-4 w-4 mr-2" />
                  {isSaving ? "Saving..." : "Save"}
                </Button>
              </div>
            )}
          </div>
        </SheetHeader>

        {/* Tabs */}
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
            {/* Overview Tab */}
            <TabsContent value="overview" className="px-6 py-4 mt-0">
              <div className="space-y-6">
                {/* Personal Information */}
                <section>
                  <h3 className="text-sm font-medium mb-4">Personal Information</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="firstName">First Name</Label>
                      <Input
                        id="firstName"
                        value={editedUser?.firstName || ""}
                        onChange={(e) =>
                          setEditedUser((prev) =>
                            prev ? { ...prev, firstName: e.target.value } : null
                          )
                        }
                        disabled={!isEditing}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="lastName">Last Name</Label>
                      <Input
                        id="lastName"
                        value={editedUser?.lastName || ""}
                        onChange={(e) =>
                          setEditedUser((prev) =>
                            prev ? { ...prev, lastName: e.target.value } : null
                          )
                        }
                        disabled={!isEditing}
                      />
                    </div>
                    <div className="space-y-2 col-span-2">
                      <Label htmlFor="email">Email</Label>
                      <Input id="email" value={user.email} disabled className="bg-muted" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="jobTitle">Job Title</Label>
                      <Input
                        id="jobTitle"
                        value={editedUser?.jobTitle || ""}
                        onChange={(e) =>
                          setEditedUser((prev) =>
                            prev ? { ...prev, jobTitle: e.target.value } : null
                          )
                        }
                        disabled={!isEditing}
                        placeholder="e.g., Teacher"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="organization">School/Department</Label>
                      <Input
                        id="organization"
                        value={editedUser?.organization || ""}
                        onChange={(e) =>
                          setEditedUser((prev) =>
                            prev ? { ...prev, organization: e.target.value } : null
                          )
                        }
                        disabled={!isEditing}
                        placeholder="e.g., Peninsula High School"
                      />
                    </div>
                  </div>
                </section>

                <Separator />

                {/* Account Status */}
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
                        onValueChange={(value) =>
                          setEditedUser((prev) =>
                            prev ? { ...prev, roles: [value] } : null
                          )
                        }
                        disabled={!isEditing}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {roles.map((role) => (
                            <SelectItem key={role.id} value={role.id}>
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

            {/* Permissions Tab */}
            <TabsContent value="permissions" className="px-6 py-4 mt-0">
              <div className="space-y-6">
                {/* Model Access */}
                <section>
                  <h3 className="text-sm font-medium mb-4">Model Access</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Configure which AI models this user can access
                  </p>
                  <div className="space-y-3">
                    {localModelAccess.length > 0 ? (
                      localModelAccess.map((model) => (
                        <div
                          key={model.id}
                          className="flex items-center justify-between py-2 px-3 rounded-lg border"
                        >
                          <div>
                            <p className="text-sm font-medium">{model.name}</p>
                            <p className="text-xs text-muted-foreground">{model.provider}</p>
                          </div>
                          <Switch
                            checked={model.enabled}
                            onCheckedChange={(checked) => handleModelToggle(model.id, checked)}
                            disabled={!isEditing}
                          />
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground py-8 text-center">
                        Model access configuration will be available in a future update.
                      </p>
                    )}
                  </div>
                </section>

                <Separator />

                {/* Tool Access (placeholder for future) */}
                <section>
                  <h3 className="text-sm font-medium mb-4">Tool Access</h3>
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    Tool-level permissions are managed through roles.
                  </p>
                </section>
              </div>
            </TabsContent>

            {/* API Usage Tab */}
            <TabsContent value="usage" className="px-6 py-4 mt-0">
              <div className="space-y-6">
                <section>
                  <h3 className="text-sm font-medium mb-4">Usage Summary</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 rounded-lg border bg-muted/50">
                      <p className="text-2xl font-bold">
                        {user.activitySummary?.assistantExecutions ?? 0}
                      </p>
                      <p className="text-sm text-muted-foreground">Assistant Executions</p>
                    </div>
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
                      <p className="text-sm text-muted-foreground">Nexus Conversations</p>
                    </div>
                    <div className="p-4 rounded-lg border bg-muted/50">
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

            {/* Activity Log Tab */}
            <TabsContent value="activity" className="px-6 py-4 mt-0">
              <div className="space-y-4">
                <h3 className="text-sm font-medium">Recent Activity</h3>

                {loadingActivity ? (
                  <div className="space-y-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="flex gap-3">
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
                    {activityLog.map((entry) => (
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
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
