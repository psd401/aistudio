import { requireRole } from "@/lib/auth/role-helpers"
import { listMcpServers } from "@/actions/admin/connector.actions"
import { ConnectorsPageClient } from "./_components/connectors-page-client"
import { PageBranding } from "@/components/ui/page-branding"

export default async function ConnectorsPage() {
  await requireRole("administrator")

  const serversResult = await listMcpServers()
  const servers = serversResult.isSuccess ? (serversResult.data ?? []) : []
  const fetchError = !serversResult.isSuccess
    ? (serversResult.message ?? "Failed to load connectors")
    : null

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">
          MCP Connectors
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage MCP servers available as connectors in Nexus Chat
        </p>
      </div>

      <ConnectorsPageClient initialServers={servers} fetchError={fetchError} />
    </div>
  )
}
