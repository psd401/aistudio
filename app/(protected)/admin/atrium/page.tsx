import { notFound } from "next/navigation"
import { adminPageMetadata } from "../_lib/admin-pages"
import { hasRole } from "@/lib/auth/role-helpers"
import { PageBranding } from "@/components/ui/page-branding"
import {
  listPendingApprovalsAction,
  isCollectionApproverAction,
  type PendingApprovalDTO,
} from "@/actions/db/atrium/approvals"
import {
  listContentAuditAction,
  type ContentAuditPage,
} from "@/actions/db/atrium/audit-log"
import type { CollectionDTO } from "@/lib/content"
import { AtriumAdminTabs } from "@/components/atrium/admin/atrium-admin-tabs"
import { listManageableCollectionsAction } from "@/actions/db/atrium/collection-management"

/**
 * Atrium oversight (Epic #1059 completion) — the surface for the publish
 * approval queue (`content_publish_requests`, migration 096), district
 * collection management, and the content audit trail (`content_audit_logs`,
 * migration 090).
 *
 * ## Why this is no longer a plain `requireRole("administrator")` page
 *
 * Migration 178 made the approver roster per-collection and configurable, so a
 * department's SOP owner can clear their own section's queue without district
 * admin involvement. Gating the whole page on the administrator role would
 * have made that configurability unreachable — there would be a roster and
 * nowhere for the people on it to act.
 *
 * The widening is entry ONLY. A non-admin approver sees the Approvals tab and
 * nothing else (`isAdmin` is threaded to the tab strip), the queue itself is
 * filtered to the collections they actually approve, and every decision action
 * re-checks authority server-side. Collection management and the audit trail
 * remain administrator-only in both the UI and their own actions.
 */
export const metadata = adminPageMetadata("/admin/atrium")

/**
 * Unwrap one panel's `ActionState` into a value + error message.
 *
 * `null` means the action was deliberately NOT called (an administrator-only
 * panel for a collection approver), which is not an error — the tab is not
 * rendered, so surfacing "failed to load" for it would be a lie.
 */
function unwrap<T>(
  result: { isSuccess: boolean; data?: T; message?: string | null } | null,
  fallback: T,
  errorLabel: string
): { value: T; error: string | null } {
  if (result == null) return { value: fallback, error: null }
  if (result.isSuccess) return { value: result.data ?? fallback, error: null }
  return { value: fallback, error: result.message ?? errorLabel }
}

/**
 * Load the three panels' initial data.
 *
 * The audit trail and collection management are administrator-only, so for a
 * collection approver they are not fetched at all rather than fetched and
 * discarded — their own actions would refuse the call, and issuing it would
 * mean a guaranteed error round-trip on every page load. The Usage tab loads
 * itself on activation (a dozen aggregates most visits never open).
 *
 * Extracted from the page component to keep it under the complexity lint.
 */
async function loadPanels(isAdmin: boolean) {
  const [approvalsResult, auditResult, collectionsResult] = await Promise.all([
    listPendingApprovalsAction(),
    isAdmin ? listContentAuditAction({}) : null,
    isAdmin ? listManageableCollectionsAction() : null,
  ])

  const approvals = unwrap(approvalsResult, [] as PendingApprovalDTO[], "Failed to load pending approvals")
  const audit = unwrap(
    auditResult,
    { rows: [], total: 0, page: 1, pageSize: 50 } as ContentAuditPage,
    "Failed to load the audit log"
  )
  const collections = unwrap(collectionsResult, [] as CollectionDTO[], "Failed to load collections")

  return {
    approvals: approvals.value,
    approvalsError: approvals.error,
    audit: audit.value,
    auditError: audit.error,
    collections: collections.value,
    collectionsError: collections.error,
  }
}

export default async function AtriumAdminPage() {
  const isAdmin = await hasRole("administrator")
  // 404, not 403: a non-approver must not learn this page exists, matching the
  // existence-masking rule the rest of Atrium follows.
  if (!isAdmin) {
    const approverResult = await isCollectionApproverAction()
    if (!approverResult.isSuccess || !approverResult.data) notFound()
  }

  const {
    approvals,
    approvalsError,
    audit,
    auditError,
    collections,
    collectionsError,
  } = await loadPanels(isAdmin)

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-foreground">
          Atrium Oversight
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isAdmin
            ? "Manage district collections, approve publish requests, review the content audit trail, and see how Atrium is being used"
            : "Approve publish requests for the sections you review"}
        </p>
      </div>

      <AtriumAdminTabs
        initialApprovals={approvals}
        approvalsError={approvalsError}
        initialAudit={audit}
        auditError={auditError}
        initialCollections={collections}
        collectionsError={collectionsError}
        isAdmin={isAdmin}
      />
    </div>
  )
}
