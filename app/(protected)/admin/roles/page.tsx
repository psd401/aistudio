"use server"

import { RolesTable } from "./_components/roles-table"
import { requireRole } from "@/lib/auth/role-helpers"
import { getRoles, getTools } from "@/lib/db/drizzle"
import { PageBranding } from "@/components/ui/page-branding"

export default async function RolesPage() {
  await requireRole("administrator");

  // Fetch roles and tools from the database
  const [roles, tools] = await Promise.all([
    getRoles(),
    getTools()
  ]);

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">Role Management</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure roles and their tool permissions
        </p>
      </div>
      <RolesTable roles={roles || []} tools={tools || []} />
    </div>
  )
} 