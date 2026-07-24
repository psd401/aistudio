import { adminPageMetadata } from "../_lib/admin-pages"
import { requireRole } from "@/lib/auth/role-helpers"
import { listToolCatalogIdentifiers } from "@/lib/db/drizzle"
import { PageBranding } from "@/components/ui/page-branding"
import { ToolVersionsClient } from "./_components/tool-versions-client"

/**
 * Admin → Tools: tool catalog version history (Issue #927).
 *
 * Lists every tool identifier with its version + deprecation counts. Selecting a
 * tool loads its full version history (published date, deprecation state,
 * replaced_by, usage counts) and exposes deprecate / restore / remove actions.
 */
export const metadata = adminPageMetadata("/admin/tools")

export default async function AdminToolsPage() {
  await requireRole("administrator")

  const identifiers = await listToolCatalogIdentifiers()

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">Tool Versions</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Inspect tool catalog versions, deprecation state, and usage. Deprecate a
          version to start its grace period; remove it after the grace period ends.
        </p>
      </div>
      <ToolVersionsClient identifiers={identifiers} />
    </div>
  )
}
