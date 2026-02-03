import { requireRole } from "@/lib/auth/role-helpers"
import { UsersPageClient } from "./_components/users-page-client"

export default async function AdminUsersPage() {
  // Check admin permissions
  await requireRole("administrator")

  return <UsersPageClient />
} 