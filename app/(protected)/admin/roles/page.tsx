import { Suspense } from "react"
import { RolesTable } from "./_components/roles-table"
import { requireRole } from "@/lib/auth/role-helpers"
import { getRoles, getTools } from "@/lib/db/drizzle"

interface Role {
  id: string | number;
  name: string;
  description?: string;
  is_system?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface Tool {
  id: string;
  name: string;
  identifier: string;
  description?: string;
  isActive: boolean;
}

export default async function RolesPage() {
  await requireRole("administrator");
  
  // Fetch roles and tools from the database
  const [roles, tools] = await Promise.all([
    getRoles(),
    getTools()
  ]);
  
  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-bold">Role Management</h1>
      <Suspense fallback={<div>Loading roles...</div>}>
        <RolesTable roles={(roles as unknown as Role[]) || []} tools={(tools as unknown as Tool[]) || []} />
      </Suspense>
    </div>
  )
} 