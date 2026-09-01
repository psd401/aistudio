"use client"

/**
 * Atrium oversight tabs (Epic #1059 completion) — the admin panels of
 * /admin/atrium: the §26.4 approvals queue, district collection management,
 * the read-only content audit trail, and the usage dashboard over that trail.
 * Pure layout; each panel owns its own data + actions.
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ApprovalsQueue } from "./approvals-queue"
import { AuditLogTable } from "./audit-log-table"
import { AtriumUsagePanel } from "./atrium-usage-panel"
import { CollectionManagementPanel } from "@/components/atrium/CollectionManagementPanel"
import type { PendingApprovalDTO } from "@/actions/db/atrium/approvals"
import type { ContentAuditPage } from "@/actions/db/atrium/audit-log"
import type { AtriumUsageStats } from "@/actions/db/atrium/usage-stats"
import type { CollectionDTO } from "@/lib/content"

interface AtriumAdminTabsProps {
  initialApprovals: PendingApprovalDTO[]
  approvalsError: string | null
  initialAudit: ContentAuditPage
  auditError: string | null
  initialCollections: CollectionDTO[]
  collectionsError: string | null
  /** Null for a non-admin (the tab is not rendered) or when the load failed. */
  initialUsage: AtriumUsageStats | null
  usageError: string | null
  /**
   * District administrator. False for a collection approver (migration 178),
   * who reaches this page for their own sections' queue and must see ONLY the
   * Approvals tab — collection management and the audit trail stay
   * administrator-only. This hides them; their own server actions refuse a
   * non-admin caller independently, so this is presentation, not the boundary.
   */
  isAdmin: boolean
}

export function AtriumAdminTabs({
  initialApprovals,
  approvalsError,
  initialAudit,
  auditError,
  initialCollections,
  collectionsError,
  initialUsage,
  usageError,
  isAdmin,
}: AtriumAdminTabsProps) {
  return (
    <Tabs defaultValue="approvals">
      <TabsList>
        <TabsTrigger value="approvals">
          Approvals
          {initialApprovals.length > 0 ? ` (${initialApprovals.length})` : ""}
        </TabsTrigger>
        {isAdmin && <TabsTrigger value="collections">Collections</TabsTrigger>}
        {isAdmin && <TabsTrigger value="audit">Audit</TabsTrigger>}
        {isAdmin && <TabsTrigger value="usage">Usage</TabsTrigger>}
      </TabsList>
      <TabsContent value="approvals">
        <ApprovalsQueue
          initialRequests={initialApprovals}
          initialError={approvalsError}
        />
      </TabsContent>
      {isAdmin && (
        <TabsContent value="collections">
          <CollectionManagementPanel
            mode="admin"
            initialCollections={initialCollections}
            initialError={collectionsError}
          />
        </TabsContent>
      )}
      {isAdmin && (
        <TabsContent value="audit">
          <AuditLogTable initialData={initialAudit} initialError={auditError} />
        </TabsContent>
      )}
      {isAdmin && (
        <TabsContent value="usage">
          <AtriumUsagePanel initialStats={initialUsage} initialError={usageError} />
        </TabsContent>
      )}
    </Tabs>
  )
}
