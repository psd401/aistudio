"use client"

import { useEffect, useState } from "react"
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
import { useToast } from "@/components/ui/use-toast"
import { UsersTable } from "@/components/user/users-table"
import type { RoleChoice } from "@/components/user/multi-role-selector"
import { getRoles } from "@/actions/admin/user-management.actions"
import { User } from "@/lib/types"

/** Title-case a raw role name (e.g. "administrator" → "Administrator") for display. */
function toRoleLabel(name: string): string {
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name
}

export function UsersClient() {
  const [users, setUsers] = useState<User[]>([])
  const [availableRoles, setAvailableRoles] = useState<RoleChoice[]>([])
  const [loading, setLoading] = useState(true)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [userToDelete, setUserToDelete] = useState<{ id: number | string } | null>(null)
  const { toast } = useToast()

  const fetchUsers = async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/admin/users", { signal })
      
      // Handle status codes
      if (response.status === 401) {
        throw new Error("Unauthorized - Please log in")
      } else if (response.status === 403) {
        throw new Error("Forbidden - Admin access required")
      } else if (!response.ok) {
        throw new Error(`Server error: ${response.status}`)
      }
      
      const result = await response.json()
      
      if (!result.isSuccess) {
        throw new Error(result.message || "Failed to fetch users")
      }
      
      setUsers(result.data || [])
    } catch (error) {
      // Don't show toast if the request was aborted
      if (error instanceof Error && error.name === 'AbortError') {
        return
      }
      console.error("Error fetching users:", error)
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to load users",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const abortController = new AbortController()
    fetchUsers(abortController.signal)

    // Roles are dynamic — the assignment UI must reflect any role, including
    // those mapped in from Google groups (#1204), not a hardcoded list.
    let active = true
    getRoles()
      .then((result) => {
        if (!active) return
        if (result.isSuccess) {
          setAvailableRoles(
            result.data.map((r) => ({ value: r.name, label: toRoleLabel(r.name) }))
          )
        }
      })
      .catch(() => {
        /* non-fatal: the selector shows a "Loading roles…" hint until this resolves */
      })

    return () => {
      active = false
      abortController.abort()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleRoleChange = async (userId: number | string, newRoles: string[] | string) => {
    try {
      // Support both single role (legacy) and multiple roles
      const roles = Array.isArray(newRoles) ? newRoles : [newRoles];
      
      const response = await fetch(`/api/admin/users/${userId}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles }),
      })
      
      if (!response.ok) throw new Error("Failed to update roles")
      
      setUsers(users.map(user => 
        user.id === userId ? { ...user, roles, role: roles[0] } : user
      ))

      toast({
        title: "Success",
        description: "User roles updated successfully",
        variant: "default",
      })
    } catch {
      toast({
        title: "Error",
        description: "Failed to update user roles",
        variant: "destructive",
      })
    }
  }

  const handleDeleteUser = async (userId: number | string) => {
    setUserToDelete({ id: userId })
    setShowDeleteDialog(true)
  }

  const confirmDelete = async () => {
    if (!userToDelete) return

    try {
      const response = await fetch(`/api/admin/users/${userToDelete.id}`, {
        method: "DELETE",
      })
      
      if (!response.ok) throw new Error("Failed to delete user")
      
      setUsers(users.filter(user => user.id !== userToDelete.id))
      toast({
        title: "Success",
        description: "User deleted successfully",
        variant: "default",
      })
    } catch {
      toast({
        title: "Error",
        description: "Failed to delete user",
        variant: "destructive",
      })
    } finally {
      setShowDeleteDialog(false)
      setUserToDelete(null)
    }
  }

  if (loading) {
    return (
      <div className="flex h-[200px] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-bold">User Management</h1>
      
      <UsersTable
        users={users}
        currentUserId="" // Admin pages don't need to restrict self-edits
        availableRoles={availableRoles}
        onRoleChange={handleRoleChange}
        onDeleteUser={handleDeleteUser}
      />

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this user? This action cannot be undone.
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