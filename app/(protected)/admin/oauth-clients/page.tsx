/**
 * OAuth Clients Admin Page
 * Manage OAuth2 client applications.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import { Suspense } from "react"
import { requireRole } from "@/lib/auth/role-helpers"
import { listOAuthClients } from "@/actions/oauth/oauth-client.actions"
import { OAuthClientsPageClient } from "./_components/oauth-clients-page-client"
import { Skeleton } from "@/components/ui/skeleton"
import { PageBranding } from "@/components/ui/page-branding"

export default async function OAuthClientsPage() {
  await requireRole("administrator")

  const clientsResult = await listOAuthClients()
  const clients = clientsResult.isSuccess ? (clientsResult.data ?? []) : []
  const fetchError = !clientsResult.isSuccess ? (clientsResult.message ?? "Failed to load OAuth clients") : null

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">OAuth Clients</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage OAuth2/OIDC client applications for external service authentication
        </p>
      </div>

      {fetchError && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{fetchError}</p>
        </div>
      )}

      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <OAuthClientsPageClient initialClients={clients} />
      </Suspense>
    </div>
  )
}
