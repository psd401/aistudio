import { adminPageMetadata } from "../_lib/admin-pages"
import { requireRole } from "@/lib/auth/role-helpers"
import { NavigationManager } from "./_components/navigation-manager"

export const metadata = adminPageMetadata("/admin/navigation")

export default async function NavigationPage() {
  await requireRole("administrator")

  return (
    <div className="container mx-auto px-6 py-8">
      <NavigationManager />
    </div>
  )
} 