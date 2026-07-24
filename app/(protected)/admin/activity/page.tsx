import { adminPageMetadata } from "../_lib/admin-pages"
import { requireRole } from "@/lib/auth/role-helpers"
import { ActivityPageClient } from "./_components/activity-page-client"

export const metadata = adminPageMetadata("/admin/activity")

export default async function AdminActivityPage() {
  // Check admin permissions
  await requireRole("administrator")

  return <ActivityPageClient />
}
