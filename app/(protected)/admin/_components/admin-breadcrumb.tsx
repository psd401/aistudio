"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronLeft } from "lucide-react"

/**
 * "← Admin" back-link rendered by the admin layout on every admin page.
 * Hidden on the hub itself (/admin), which has nowhere to go back to.
 */
export function AdminBreadcrumb() {
  const pathname = usePathname()
  if (pathname === "/admin") return null

  return (
    <Link
      href="/admin"
      data-testid="admin-breadcrumb"
      className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      Admin
    </Link>
  )
}
