"use client"

/**
 * Atrium oversight tabs (Epic #1059 completion) — the two admin panels of
 * /admin/atrium: the §26.4 approvals queue and the read-only content audit
 * trail. Pure layout; each panel owns its own data + actions.
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ApprovalsQueue } from "./approvals-queue"
import { AuditLogTable } from "./audit-log-table"
import type { PendingApprovalDTO } from "@/actions/db/atrium/approvals"
import type { ContentAuditPage } from "@/actions/db/atrium/audit-log"

interface AtriumAdminTabsProps {
  initialApprovals: PendingApprovalDTO[]
  approvalsError: string | null
  initialAudit: ContentAuditPage
  auditError: string | null
}

export function AtriumAdminTabs({
  initialApprovals,
  approvalsError,
  initialAudit,
  auditError,
}: AtriumAdminTabsProps) {
  return (
    <Tabs defaultValue="approvals">
      <TabsList>
        <TabsTrigger value="approvals">
          Approvals
          {initialApprovals.length > 0 ? ` (${initialApprovals.length})` : ""}
        </TabsTrigger>
        <TabsTrigger value="audit">Audit</TabsTrigger>
      </TabsList>
      <TabsContent value="approvals">
        <ApprovalsQueue
          initialRequests={initialApprovals}
          initialError={approvalsError}
        />
      </TabsContent>
      <TabsContent value="audit">
        <AuditLogTable initialData={initialAudit} initialError={auditError} />
      </TabsContent>
    </Tabs>
  )
}
