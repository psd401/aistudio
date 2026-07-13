import { requireRole } from "@/lib/auth/role-helpers"
import { PageBranding } from "@/components/ui/page-branding"
import { getGroupsAdminDataAction } from "@/actions/db/groups-actions"
import { GroupsAdmin } from "./_components/groups-admin"

/**
 * Google Directory group-sync admin (Epic #1202, Phase 0 / #1203).
 *
 * The admin surface for the hourly group sync: selection management (hand-picked
 * emails + prefix rules), sync status (last run, per-group member counts,
 * failures), a read-only group/member browser, and a manual "Sync now" trigger.
 * Follows the admin-page convention (e.g. /admin/atrium): `requireRole` gate in
 * the server component, initial data fetched here, interactivity in a client
 * child. The nav entry (migration 107) is administrator-gated to match.
 */
export const dynamic = "force-dynamic"

export default async function GroupsAdminPage() {
  await requireRole("administrator")

  const result = await getGroupsAdminDataAction()
  const data = result.isSuccess ? result.data : null
  const error = !result.isSuccess ? (result.message ?? "Failed to load group data") : null

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-foreground">Groups</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Google Directory group sync — pick groups by email or prefix, review
          membership, and run the sync on demand. Membership refreshes hourly.
        </p>
      </div>

      <GroupsAdmin initialData={data} initialError={error} />
    </div>
  )
}
