"use client"

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  getRepositoryAccess,
  getRepositoryAccessOptions,
  grantRepositoryAccess,
  revokeRepositoryAccess,
  type RepositoryAccessEntry,
  type RepositoryAccessOptions,
} from "@/actions/repositories/repository.actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/use-toast"
import {
  AlertCircle,
  Loader2,
  Search,
  Shield,
  Trash2,
  UserRound,
} from "lucide-react"

interface RepositoryAccessEditorProps {
  repositoryId: number
  isPublic: boolean
}

const EMPTY_OPTIONS: RepositoryAccessOptions = {
  users: [],
  roles: [],
  nextUserOffset: null,
}

function accessLabel(entry: RepositoryAccessEntry): string {
  if (entry.userId) {
    return entry.userName || entry.userEmail || `User ${entry.userId}`
  }
  return entry.roleName || `Role ${entry.roleId ?? "unknown"}`
}

export function RepositoryAccessEditor({
  repositoryId,
  isPublic,
}: RepositoryAccessEditorProps) {
  const { toast } = useToast()
  const [entries, setEntries] = useState<RepositoryAccessEntry[]>([])
  const [options, setOptions] =
    useState<RepositoryAccessOptions>(EMPTY_OPTIONS)
  const [grantKind, setGrantKind] = useState<"user" | "role">("user")
  const [selectedId, setSelectedId] = useState("")
  const [userSearch, setUserSearch] = useState("")
  const [appliedUserSearch, setAppliedUserSearch] = useState("")
  const [loadingUserOptions, setLoadingUserOptions] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (search = "") => {
    const [accessResult, optionsResult] = await Promise.all([
      getRepositoryAccess(repositoryId),
      getRepositoryAccessOptions(repositoryId, search, 0),
    ])
    if (!accessResult.isSuccess || !accessResult.data) {
      setError(accessResult.message || "Failed to load repository access")
    } else if (!optionsResult.isSuccess || !optionsResult.data) {
      setError(optionsResult.message || "Failed to load access options")
    } else {
      setEntries(accessResult.data)
      setOptions(optionsResult.data)
      setError(null)
    }
    setLoading(false)
  }, [repositoryId])

  useEffect(() => {
    let cancelled = false
    async function loadInitialAccess() {
      const [accessResult, optionsResult] = await Promise.all([
        getRepositoryAccess(repositoryId),
        getRepositoryAccessOptions(repositoryId, "", 0),
      ])
      if (cancelled) return
      if (!accessResult.isSuccess || !accessResult.data) {
        setError(accessResult.message || "Failed to load repository access")
      } else if (!optionsResult.isSuccess || !optionsResult.data) {
        setError(optionsResult.message || "Failed to load access options")
      } else {
        setEntries(accessResult.data)
        setOptions(optionsResult.data)
        setError(null)
      }
      setLoading(false)
    }
    void loadInitialAccess()
    return () => {
      cancelled = true
    }
  }, [repositoryId])

  async function loadUserOptions(
    search: string,
    offset: number,
    append: boolean
  ) {
    setLoadingUserOptions(true)
    const result = await getRepositoryAccessOptions(
      repositoryId,
      search,
      offset
    )
    if (result.isSuccess && result.data) {
      const loadedOptions = result.data
      setOptions((current) => {
        if (!append) return loadedOptions

        const usersById = new Map(
          current.users.map((user) => [user.id, user])
        )
        for (const user of loadedOptions.users) {
          usersById.set(user.id, user)
        }
        return {
          ...loadedOptions,
          users: [...usersById.values()],
        }
      })
      setSelectedId("")
    } else {
      toast({
        title: "Could not search users",
        description: result.message || "User options could not be loaded.",
        variant: "destructive",
      })
    }
    setLoadingUserOptions(false)
  }

  function handleUserSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedSearch = userSearch.trim()
    setAppliedUserSearch(normalizedSearch)
    void loadUserOptions(normalizedSearch, 0, false)
  }

  const availableUsers = useMemo(() => {
    const granted = new Set(
      entries.flatMap((entry) => (entry.userId ? [entry.userId] : []))
    )
    return options.users.filter((user) => !granted.has(user.id))
  }, [entries, options.users])

  const availableRoles = useMemo(() => {
    const granted = new Set(
      entries.flatMap((entry) => (entry.roleId ? [entry.roleId] : []))
    )
    return options.roles.filter((role) => !granted.has(role.id))
  }, [entries, options.roles])

  async function handleGrant() {
    const id = Number(selectedId)
    if (!Number.isSafeInteger(id) || id <= 0) return
    setSaving(true)
    const result = await grantRepositoryAccess(
      repositoryId,
      grantKind === "user" ? id : null,
      grantKind === "role" ? id : null
    )
    if (result.isSuccess) {
      setSelectedId("")
      toast({
        title: "Access granted",
        description: "The repository access list has been updated.",
      })
      await load(appliedUserSearch)
    } else {
      toast({
        title: "Could not grant access",
        description: result.message,
        variant: "destructive",
      })
    }
    setSaving(false)
  }

  async function handleRevoke(entry: RepositoryAccessEntry) {
    setSaving(true)
    const result = await revokeRepositoryAccess(entry.id)
    if (result.isSuccess) {
      setEntries((current) =>
        current.filter((candidate) => candidate.id !== entry.id)
      )
      toast({
        title: "Access revoked",
        description: `${accessLabel(entry)} no longer has repository access.`,
      })
    } else {
      toast({
        title: "Could not revoke access",
        description: result.message,
        variant: "destructive",
      })
    }
    setSaving(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Access Control</CardTitle>
        <CardDescription>
          Grant read access to individual users or everyone assigned a role.
          Repository owners and administrators always retain management access.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isPublic ? (
          <Alert>
            <Shield className="h-4 w-4" />
            <AlertTitle>Public repository</AlertTitle>
            <AlertDescription>
              Every authenticated repository user can read this repository.
              Grants below remain recorded if the repository becomes private.
            </AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading repository access…
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Access list unavailable</AlertTitle>
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>{error}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLoading(true)
                  setError(null)
                  void load()
                }}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {grantKind === "user" ? (
              <form className="flex gap-2" onSubmit={handleUserSearch}>
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={userSearch}
                    onChange={(event) => setUserSearch(event.target.value)}
                    className="pl-9"
                    placeholder="Search by name or email"
                    aria-label="Search users to grant"
                    maxLength={100}
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={loadingUserOptions}
                >
                  {loadingUserOptions ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Search users
                </Button>
              </form>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-[140px_1fr_auto]">
              <Select
                value={grantKind}
                onValueChange={(value) => {
                  if (value === "user" || value === "role") {
                    setGrantKind(value)
                    setSelectedId("")
                  }
                }}
              >
                <SelectTrigger aria-label="Grant type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="role">Role</SelectItem>
                </SelectContent>
              </Select>
              <Select value={selectedId} onValueChange={setSelectedId}>
                <SelectTrigger
                  aria-label={`Select ${grantKind}`}
                  disabled={loadingUserOptions}
                >
                  <SelectValue placeholder={`Select a ${grantKind}`} />
                </SelectTrigger>
                <SelectContent>
                  {grantKind === "user"
                    ? availableUsers.map((user) => (
                        <SelectItem key={user.id} value={String(user.id)}>
                          {user.name} ({user.email})
                        </SelectItem>
                      ))
                    : availableRoles.map((role) => (
                        <SelectItem key={role.id} value={String(role.id)}>
                          {role.name}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
              <Button
                onClick={() => void handleGrant()}
                disabled={!selectedId || saving}
              >
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Grant access
              </Button>
            </div>
            {grantKind === "user" && options.nextUserOffset !== null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void loadUserOptions(
                    appliedUserSearch,
                    options.nextUserOffset!,
                    true
                  )
                }
                disabled={loadingUserOptions}
              >
                {loadingUserOptions ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Load more users
              </Button>
            ) : null}

            <div className="divide-y rounded-md border">
              {entries.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No additional user or role grants.
                </p>
              ) : (
                entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between gap-3 p-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {entry.userId ? (
                        <UserRound className="h-4 w-4 shrink-0" />
                      ) : (
                        <Shield className="h-4 w-4 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {accessLabel(entry)}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {entry.userId
                            ? entry.userEmail || "Individual user"
                            : "All users assigned this role"}
                        </p>
                      </div>
                      <Badge variant="outline">
                        {entry.userId ? "User" : "Role"}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => void handleRevoke(entry)}
                      disabled={saving}
                      aria-label={`Revoke access for ${accessLabel(entry)}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
