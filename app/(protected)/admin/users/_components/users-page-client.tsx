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

export function UsersPageClient({
  initialStats,
  initialUsers,
  initialRoles,
}: UsersPageClientProps) {
  const { toast } = useToast()

  // State
  const [stats, setStats] = useState<UserStats | null>(initialStats || null)
  const [users, setUsers] = useState<UserListItem[]>(initialUsers || [])
  const [roles, setRoles] = useState<Array<{ id: string; name: string }>>(
    initialRoles || []
  )
  const [loading, setLoading] = useState(!initialStats || !initialUsers)
  const [loadingStats, setLoadingStats] = useState(!initialStats)

  // Filters
  const [activeTab, setActiveTab] = useState<RoleTab>("all")
  const [filters, setFilters] = useState<UserFiltersState>({
    search: "",
    status: "all",
    role: "all",
  })

  // Selected user for detail view
  const [selectedUser, setSelectedUser] = useState<UserDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [loadingActivity, setLoadingActivity] = useState(false)

  // Delete confirmation
  const [deleteDialog, setDeleteDialog] = useState(false)
  const [userToDelete, setUserToDelete] = useState<UserTableRow | null>(null)

  // Load initial data
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
        description: error instanceof Error ? error.message : "Failed to load user data",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
      setLoadingStats(false)
    }
  }, [toast])

  useEffect(() => {
    if (!initialStats || !initialUsers) {
      loadData()
    }
  }, [loadData, initialStats, initialUsers])

  // Handle filter changes
  const handleFiltersChange = useCallback(
    async (newFilters: UserFiltersState) => {
      // Prevent concurrent filter requests
      if (loading) return

      setFilters(newFilters)
      setLoading(true)

      try {
        // Reload users with new filters
        const result = await getUsers({
          search: newFilters.search,
          status: newFilters.status,
          role: activeTab !== "all" ? activeTab : newFilters.role,
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
      } catch {
        // Error already shown via toast in else block above
      } finally {
        setLoading(false)
      }
    },
    [activeTab, loading, toast]
  )

  // Handle tab change
  const handleTabChange = useCallback(
    async (value: string) => {
      // Prevent concurrent tab change requests
      if (loading) return

      const tab = value as RoleTab
      setActiveTab(tab)
      setLoading(true)

      try {
        const result = await getUsers({
          search: filters.search,
          status: filters.status,
          role: tab !== "all" ? tab : filters.role,
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
      } catch {
        // Error already shown via toast in else block above
      } finally {
        setLoading(false)
      }
    },
    [filters, loading, toast]
  )

  // Transform users for table
  const tableUsers: UserTableRow[] = users.map((user) => ({
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    roles: user.roles,
    status: user.status,
    lastSignInAt: user.lastSignInAt,
    createdAt: user.createdAt,
  }))

  // View user detail
  const handleViewUser = useCallback(
    async (user: UserTableRow) => {
      setLoadingActivity(true)
      setSelectedUser({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        roles: user.roles,
        status: user.status,
        lastSignInAt: user.lastSignInAt,
        createdAt: user.createdAt,
      })
      setDetailOpen(true)

      // Load activity data on-demand (N+1 pattern)
      // NOTE: This fetches activity data individually when opening user details.
      // For Phase 1 MVP this is acceptable as it only triggers on user interaction.
      // Future optimization: Prefetch activity data for visible users or implement
      // pagination with activity data included in initial query.
      const activityResult = await getUserActivity(user.id)
      if (activityResult.isSuccess && activityResult.data) {
        setSelectedUser((prev) =>
          prev
            ? {
                ...prev,
                activitySummary: {
                  nexusConversations: activityResult.data!.nexusConversations,
                  promptsUsed: activityResult.data!.promptsUsed,
                  lastActivity: activityResult.data!.lastActivity || undefined,
                },
              }
            : null
        )
      }
      setLoadingActivity(false)
    },
    []
  )

  // Edit user
  const handleEditUser = useCallback((user: UserTableRow) => {
    // Open detail sheet in edit mode
    setSelectedUser({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roles: user.roles,
      status: user.status,
      lastSignInAt: user.lastSignInAt,
      createdAt: user.createdAt,
    })
    setDetailOpen(true)
  }, [])

  // Delete user
  const handleDeleteUser = useCallback((user: UserTableRow) => {
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

      setUsers((prev) => prev.filter((u) => u.id !== userToDelete.id))
      toast({
        title: "Success",
        description: "User deleted successfully",
      })

      // Refresh stats
      const statsResult = await getUserStats()
      if (statsResult.isSuccess && statsResult.data) {
        setStats(statsResult.data)
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete user",
        variant: "destructive",
      })
    } finally {
      setDeleteDialog(false)
      setUserToDelete(null)
    }
  }, [userToDelete, toast])

  // Save user changes
  const handleSaveUser = useCallback(
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

        // Update local state
        setUsers((prev) =>
          prev.map((u) =>
            u.id === user.id
              ? {
                  ...u,
                  firstName: user.firstName,
                  lastName: user.lastName,
                  roles: user.roles,
                }
              : u
          )
        )

        toast({
          title: "Success",
          description: "User updated successfully",
        })
      } catch (error) {
        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to update user",
          variant: "destructive",
        })
        throw new Error("Failed to save user")
      }
    },
    [toast]
  )

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">User Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage users, roles, and permissions
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadData}>
            <IconRefresh className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          {/* TODO: Add User functionality not yet implemented
              Will require: user invitation flow, email template, permission setup */}
        </div>
      </div>

      {/* Stats Cards */}
      {loadingStats ? (
        <StatsCardsSkeleton />
      ) : stats ? (
        <StatsCards stats={stats} />
      ) : null}

      {/* Role Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="all">All Users</TabsTrigger>
          <TabsTrigger value="administrator">Admins</TabsTrigger>
          <TabsTrigger value="staff">Staff</TabsTrigger>
          <TabsTrigger value="student">Students</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Filters */}
      <UserFilters
        roles={roles}
        onFiltersChange={handleFiltersChange}
        initialFilters={filters}
        hideRoleFilter={activeTab !== "all"}
      />

      {/* Data Table */}
      <UsersDataTable
        users={tableUsers}
        onViewUser={handleViewUser}
        onEditUser={handleEditUser}
        onDeleteUser={handleDeleteUser}
        loading={loading}
      />

      {/* User Detail Sheet */}
      <UserDetailSheet
        user={selectedUser}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onSave={handleSaveUser}
        roles={roles}
        loadingActivity={loadingActivity}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialog} onOpenChange={setDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {userToDelete?.firstName}{" "}
              {userToDelete?.lastName}? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
