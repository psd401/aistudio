import { adminPageMetadata } from "../_lib/admin-pages"
import { requireRole } from "@/lib/auth/role-helpers"
import { PageBranding } from "@/components/ui/page-branding"
import { listPendingApprovalsAction } from "@/actions/db/atrium/approvals"
import { listContentAuditAction } from "@/actions/db/atrium/audit-log"
import { AtriumAdminTabs } from "@/components/atrium/admin/atrium-admin-tabs"

/**
 * Atrium oversight (Epic #1059 completion) — the admin surface for the §26.4
 * public-publish approval queue (`content_publish_requests`, migration 096) and
 * the content audit trail (`content_audit_logs`, migration 090). Follows the
 * admin page convention (e.g. /admin/connectors): `requireRole` gate in the
 * server component, initial data fetched here, interactivity in a client child.
 */
export const metadata = adminPageMetadata("/admin/atrium")

export default async function AtriumAdminPage() {
  await requireRole("administrator")

  const [approvalsResult, auditResult] = await Promise.all([
    listPendingApprovalsAction(),
    listContentAuditAction({}),
  ])

  const approvals = approvalsResult.isSuccess ? (approvalsResult.data ?? []) : []
  const approvalsError = !approvalsResult.isSuccess
    ? (approvalsResult.message ?? "Failed to load pending approvals")
    : null
  const audit = auditResult.isSuccess
    ? auditResult.data
    : { rows: [], total: 0, page: 1, pageSize: 50 }
  const auditError = !auditResult.isSuccess
    ? (auditResult.message ?? "Failed to load the audit log")
    : null

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-foreground">
          Atrium Oversight
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Approve or deny public-publish requests and review the content audit
          trail
        </p>
      </div>

      <AtriumAdminTabs
        initialApprovals={approvals}
        approvalsError={approvalsError}
        initialAudit={audit}
        auditError={auditError}
      />
    </div>
  )
}
