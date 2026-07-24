import { adminPageMetadata } from "../_lib/admin-pages"
import { requireRole } from "@/lib/auth/role-helpers"
import { RepositoriesAdminClient } from "./_components/repositories-admin-client"

export const metadata = adminPageMetadata("/admin/repositories")

export default async function AdminRepositoriesPage() {
  // Check admin permissions
  await requireRole("administrator")

  return <RepositoriesAdminClient />
}