"use server"

import { RolesTable } from "./_components/roles-table"
import { requireRole } from "@/lib/auth/role-helpers"
import { getRoles, getTools } from "@/lib/db/drizzle"

interface Role {
  id: number;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface Tool {
  id: number;
  identifier: string;
  name: string;
  description: string | null;
  promptChainToolId: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
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
      <RolesTable roles={roles || []} tools={tools || []} />
    </div>
  )
} 