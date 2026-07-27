/**
 * User Management Page Client Component
 *
 * TODO: E2E Test Coverage Required
 * Per CLAUDE.md requirements, the following E2E tests need to be implemented in /tests/e2e/working-tests.spec.ts:
 *
 * 1. User listing with filters:
 *    - Search by name/email (debounced)
 *    - Filter by status (active/inactive/pending)
 *    - Filter by role (administrator/staff/student)
 *    - Role tabs functionality
 *    - Clear filters button
 *
 * 2. User detail sheet interactions:
 *    - Open detail sheet from table row click
 *    - View user information (name, email, roles, status, dates)
 *    - Switch between tabs (Overview, Permissions, API Usage, Activity)
 *    - Loading state for activity data
 *
 * 3. Role updates:
 *    - Edit user name (firstName, lastName)
 *    - Change user role (single role selection)
 *    - Save changes successfully
 *    - Cancel edit mode
 *    - Error handling for failed updates
 *
 * 4. User deletion flow:
 *    - Open delete confirmation dialog
 *    - Cancel deletion
 *    - Confirm deletion
 *    - Verify user removed from list
 *    - Stats refresh after deletion
 *    - Error handling for failed deletion
 *    - Prevent self-deletion
 *
 * 5. Stats display:
 *    - Total users count
 *    - Active users (signed in within 30 days)
 *    - Pending invites (never signed in)
 *    - Administrator count
 *    - Stats update after user operations
 *
 * 6. Race condition prevention:
 *    - Multiple rapid filter changes handled correctly
 *    - Multiple rapid tab changes handled correctly
 */
"use client"

import { useState, useEffect, useCallback } from "react"
import type { Dispatch, SetStateAction } from "react"
import { useToast } from "@/components/ui/use-toast"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { IconRefresh } from "@tabler/icons-react"
import { PageBranding } from "@/components/ui/page-branding"

import {
  StatsCards,
  StatsCardsSkeleton,
  UserFilters,
  UsersDataTable,
  UserDetailSheet,
  type UserStats,
  type UserFiltersState,
  type UserTableRow,
  type UserDetail,
} from "./index"
import {
  getUserStats,
  getUsers,
  getRoles,
  getUserActivity,
  updateUser,
  deleteUser,
  type UserListItem,
} from "@/actions/admin/user-management.actions"

type RoleTab = "all" | "administrator" | "staff" | "student"

interface UsersPageClientProps {
  initialStats?: UserStats
  initialUsers?: UserListItem[]
  initialRoles?: Array<{ id: string; name: string }>
}

type Toast = ReturnType<typeof useToast>["toast"]
type RoleOption = { id: string; name: string }

function useUsersData(
  {
    initialRoles,
    initialStats,
    initialUsers,
  }: UsersPageClientProps,
  toast: Toast
) {
  const [stats, setStats] = useState<UserStats | null>(initialStats || null)
  const [users, setUsers] = useState<UserListItem[]>(initialUsers || [])
  const [roles, setRoles] = useState<RoleOption[]>(initialRoles || [])
  const [loading, setLoading] = useState(!initialStats || !initialUsers)
  const [loadingStats, setLoadingStats] = useState(!initialStats)
  const [activeTab, setActiveTab] = useState<RoleTab>("all")
  const [filters, setFilters] = useState<UserFiltersState>({
    search: "",
    status: "all",
    role: "all",
  })

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [statsResult, usersResult, rolesResult] = await Promise.all([
        getUserStats(),
        getUsers(),
        getRoles(),
      ])
      if (statsResult.isSuccess && statsResult.data) {
        setStats(statsResult.data)
      }
      if (usersResult.isSuccess && usersResult.data) {
        setUsers(usersResult.data)
      }
      if (rolesResult.isSuccess && rolesResult.data) {
        setRoles(rolesResult.data)
      }
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to load user data",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
      setLoadingStats(false)
    }
  }, [toast])

  useEffect(() => {
    if (!initialStats || !initialUsers) void loadData()
  }, [initialStats, initialUsers, loadData])

  const loadFilteredUsers = useCallback(
    async (nextFilters: UserFiltersState, roleTab: RoleTab) => {
      setLoading(true)
      try {
        const result = await getUsers({
          search: nextFilters.search,
          status: nextFilters.status,
          role: roleTab !== "all" ? roleTab : nextFilters.role,
        })
        if (result.isSuccess && result.data) {
          setUsers(result.data)
        } else if (!result.isSuccess) {
          toast({
            title: "Error",
            description: result.message || "Failed to load users",
            variant: "destructive",
          })
        }
      } finally {
        setLoading(false)
      }
    },
    [toast]
  )

  const handleFiltersChange = useCallback(
    (nextFilters: UserFiltersState) => {
      if (loading) return
      setFilters(nextFilters)
      void loadFilteredUsers(nextFilters, activeTab)
    },
    [activeTab, loadFilteredUsers, loading]
  )
  const handleTabChange = useCallback(
    (value: string) => {
      if (loading) return
      const tab = value as RoleTab
      setActiveTab(tab)
      void loadFilteredUsers(filters, tab)
    },
    [filters, loadFilteredUsers, loading]
  )
  return {
    activeTab,
    filters,
    handleFiltersChange,
    handleTabChange,
    loadData,
    loading,
    loadingStats,
    roles,
    setStats,
    setUsers,
    stats,
    users,
  }
}

function toUserDetail(user: UserTableRow): UserDetail {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    roles: user.roles,
    status: user.status,
    lastSignInAt: user.lastSignInAt,
    createdAt: user.createdAt,
  }
}

function useSelectedUser() {
  const [selectedUser, setSelectedUser] = useState<UserDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [loadingActivity, setLoadingActivity] = useState(false)

  const openUser = useCallback(async (user: UserTableRow) => {
    setLoadingActivity(true)
    setSelectedUser(toUserDetail(user))
    setDetailOpen(true)
    const result = await getUserActivity(user.id)
    if (result.isSuccess && result.data) {
      setSelectedUser(previous =>
        previous
          ? {
              ...previous,
              activitySummary: {
                nexusConversations: result.data!.nexusConversations,
                promptsUsed: result.data!.promptsUsed,
                lastActivity: result.data!.lastActivity || undefined,
              },
            }
          : null
      )
    }
    setLoadingActivity(false)
  }, [])
  return {
    detailOpen,
    loadingActivity,
    openUser,
    selectedUser,
    setDetailOpen,
  }
}

function useUserMutations({
  setStats,
  setUsers,
  toast,
}: {
  setStats: Dispatch<SetStateAction<UserStats | null>>
  setUsers: Dispatch<SetStateAction<UserListItem[]>>
  toast: Toast
}) {
  const [deleteDialog, setDeleteDialog] = useState(false)
  const [userToDelete, setUserToDelete] = useState<UserTableRow | null>(null)
  const requestDelete = useCallback((user: UserTableRow) => {
    setUserToDelete(user)
    setDeleteDialog(true)
  }, [])
  const confirmDelete = useCallback(async () => {
    if (!userToDelete) return
    try {
      const result = await deleteUser(userToDelete.id)
      if (!result.isSuccess) {
        throw new Error(result.message || "Failed to delete user")
      }
      setUsers(previous =>
        previous.filter(user => user.id !== userToDelete.id)
      )
      toast({ title: "Success", description: "User deleted successfully" })
      const statsResult = await getUserStats()
      if (statsResult.isSuccess && statsResult.data) {
        setStats(statsResult.data)
      }
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to delete user",
        variant: "destructive",
      })
    } finally {
      setDeleteDialog(false)
      setUserToDelete(null)
    }
  }, [setStats, setUsers, toast, userToDelete])

  const saveUser = useCallback(
    async (user: UserDetail) => {
      try {
        const result = await updateUser(user.id, {
          firstName: user.firstName,
          lastName: user.lastName,
          roles: user.roles,
        })
        if (!result.isSuccess) {
          throw new Error(result.message || "Failed to update user")
        }
        const persistedRoles = result.data?.roles ?? user.roles
        setUsers(previous =>
          previous.map(current =>
            current.id === user.id
              ? {
                  ...current,
                  firstName: user.firstName,
                  lastName: user.lastName,
                  roles: persistedRoles,
                }
              : current
          )
        )
        toast({ title: "Success", description: "User updated successfully" })
      } catch (error) {
        toast({
          title: "Error",
          description:
            error instanceof Error ? error.message : "Failed to update user",
          variant: "destructive",
        })
        throw new Error("Failed to save user", { cause: error })
      }
    },
    [setUsers, toast]
  )
  return {
    confirmDelete,
    deleteDialog,
    requestDelete,
    saveUser,
    setDeleteDialog,
    userToDelete,
  }
}

function toTableUsers(users: UserListItem[]): UserTableRow[] {
  return users.map(user => ({
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    roles: user.roles,
    status: user.status,
    lastSignInAt: user.lastSignInAt,
    createdAt: user.createdAt,
  }))
}

export function UsersPageClient({
  initialStats,
  initialUsers,
  initialRoles,
}: UsersPageClientProps) {
  const { toast } = useToast()
  const userData = useUsersData(
    { initialRoles, initialStats, initialUsers },
    toast
  )
  const selected = useSelectedUser()
  const mutations = useUserMutations({
    setStats: userData.setStats,
    setUsers: userData.setUsers,
    toast,
  })
  const tableUsers = toTableUsers(userData.users)

  return (
    <div className="p-6 space-y-6" data-testid="user-management-page">
      {/* Header */}
      <div className="mb-6">
        <PageBranding />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">User Management</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage users, roles, and permissions
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void userData.loadData()}
            >
              <IconRefresh className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      {userData.loadingStats ? (
        <StatsCardsSkeleton />
      ) : userData.stats ? (
        <StatsCards stats={userData.stats} />
      ) : null}

      {/* Role Tabs */}
      <Tabs
        value={userData.activeTab}
        onValueChange={userData.handleTabChange}
      >
        <TabsList>
          <TabsTrigger value="all">All Users</TabsTrigger>
          <TabsTrigger value="administrator">Admins</TabsTrigger>
          <TabsTrigger value="staff">Staff</TabsTrigger>
          <TabsTrigger value="student">Students</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Filters */}
      <UserFilters
        roles={userData.roles}
        onFiltersChange={userData.handleFiltersChange}
        initialFilters={userData.filters}
        hideRoleFilter={userData.activeTab !== "all"}
      />

      {/* Data Table */}
      <UsersDataTable
        users={tableUsers}
        onViewUser={selected.openUser}
        onEditUser={selected.openUser}
        onDeleteUser={mutations.requestDelete}
        loading={userData.loading}
      />

      {/* User Detail Sheet */}
      <UserDetailSheet
        user={selected.selectedUser}
        open={selected.detailOpen}
        onOpenChange={selected.setDetailOpen}
        onSave={mutations.saveUser}
        roles={userData.roles}
        loadingActivity={selected.loadingActivity}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={mutations.deleteDialog}
        onOpenChange={mutations.setDeleteDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              {mutations.userToDelete?.firstName}{" "}
              {mutations.userToDelete?.lastName}? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void mutations.confirmDelete()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
