import { adminPageMetadata } from "../_lib/admin-pages"
import { requireRole } from "@/lib/auth/role-helpers"
import { PageBranding } from "@/components/ui/page-branding"
import { getOneRosterAdminDataAction } from "@/actions/db/roster-admin-actions"
import { RostersAdmin } from "./_components/rosters-admin"

/**
 * ClassLink OneRoster administrator control surface (Epic #1308 / #1311).
 *
 * The page and every backing server action are administrator-gated. Synced
 * roster data is read-only here; only the isolated Lambda mutates it.
 */
export const dynamic = "force-dynamic"

export const metadata = adminPageMetadata("/admin/rosters")

export default async function RostersAdminPage() {
  await requireRole("administrator")

  const result = await getOneRosterAdminDataAction()
  const data = result.isSuccess ? result.data : null
  const error = !result.isSuccess
    ? result.message ?? "Failed to load OneRoster data"
    : null

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-foreground">Rosters</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure ClassLink, run the nightly OneRoster import on demand, and
          inspect the read-only school, class, and enrollment snapshot.
        </p>
      </div>

      <RostersAdmin initialData={data} initialError={error} />
    </div>
  )
}
