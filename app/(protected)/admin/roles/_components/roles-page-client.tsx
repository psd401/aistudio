"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RolesTable } from "./roles-table"
import {
  CapabilitiesTable,
  type CapabilityRow,
  type RoleOption,
} from "./capabilities-table"

interface Role {
  id: number
  name: string
  description: string | null
  isSystem: boolean
  createdAt: Date
  updatedAt: Date
}

interface Tool {
  id: number
  identifier: string
  name: string
  description: string | null
  promptChainToolId: number | null
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

interface RolesPageClientProps {
  roles: Role[]
  tools: Tool[]
  capabilities: CapabilityRow[]
}

export function RolesPageClient({
  roles,
  tools,
  capabilities,
}: RolesPageClientProps) {
  const roleOptions: RoleOption[] = roles.map((r) => ({
    id: r.id,
    name: r.name,
  }))

  return (
    <Tabs defaultValue="roles" className="space-y-4">
      <TabsList>
        <TabsTrigger value="roles">Roles</TabsTrigger>
        <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
      </TabsList>

      <TabsContent value="roles">
        <RolesTable roles={roles} tools={tools} />
      </TabsContent>

      <TabsContent value="capabilities">
        <CapabilitiesTable capabilities={capabilities} roles={roleOptions} />
      </TabsContent>
    </Tabs>
  )
}
