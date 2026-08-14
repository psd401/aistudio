"use client"

/**
 * Atrium oversight tabs (Epic #1059 completion) — the two admin panels of
 * /admin/atrium: the §26.4 approvals queue and the read-only content audit
 * trail. Pure layout; each panel owns its own data + actions.
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ApprovalsQueue } from "./approvals-queue"
import { AuditLogTable } from "./audit-log-table"
import { CollectionManagementPanel } from "@/components/atrium/CollectionManagementPanel"
import type { PendingApprovalDTO } from "@/actions/db/atrium/approvals"
import type { ContentAuditPage } from "@/actions/db/atrium/audit-log"
import type { CollectionDTO } from "@/lib/content"

interface AtriumAdminTabsProps {
  initialApprovals: PendingApprovalDTO[]
  approvalsError: string | null
  initialAudit: ContentAuditPage
  auditError: string | null
  initialCollections: CollectionDTO[]
  collectionsError: string | null
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
    </Tabs>
  )
}
