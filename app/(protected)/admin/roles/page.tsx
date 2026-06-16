import { RolesPageClient } from "./_components/roles-page-client"
import { requireRole } from "@/lib/auth/role-helpers"
import { getRoles, getTools, getCapabilities } from "@/lib/db/drizzle"
import { PageBranding } from "@/components/ui/page-branding"

export default async function RolesPage() {
  await requireRole("administrator");

  // Fetch roles, tools (legacy selection list), and capabilities.
  const [roles, tools, capabilities] = await Promise.all([
    getRoles(),
    getTools(),
    getCapabilities()
  ]);

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">Role &amp; Capability Management</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure roles, their capability permissions, and the capability registry
        </p>
      </div>
      <RolesPageClient
        roles={roles || []}
        tools={tools || []}
        capabilities={capabilities || []}
      />
    </div>
  )
}
