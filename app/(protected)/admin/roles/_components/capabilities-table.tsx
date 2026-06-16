"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { IconEdit, IconUsersGroup } from "@tabler/icons-react"
import { useToast } from "@/components/ui/use-toast"
import { CapabilityForm } from "./capability-form"
import { CapabilityRoleAssignments } from "./capability-role-assignments"
import { setCapabilityActiveAction } from "@/actions/admin/capabilities.actions"

export interface CapabilityRow {
  id: number
  identifier: string
  name: string
  description: string | null
  isActive: boolean
  source: "code" | "manual"
}

export interface RoleOption {
  id: number
  name: string
}

interface CapabilitiesTableProps {
  capabilities: CapabilityRow[]
  roles: RoleOption[]
}

export function CapabilitiesTable({
  capabilities,
  roles,
}: CapabilitiesTableProps) {
  const { toast } = useToast()
  const [, startTransition] = useTransition()
  const [editing, setEditing] = useState<CapabilityRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [assigning, setAssigning] = useState<CapabilityRow | null>(null)
  // Track in-flight toggles to disable the switch and reflect optimistic state.
  const [pendingToggles, setPendingToggles] = useState<Record<number, boolean>>(
    {}
  )

  const handleToggleActive = (capability: CapabilityRow) => {
    const next = !capability.isActive
    setPendingToggles((prev) => ({ ...prev, [capability.id]: true }))

    startTransition(async () => {
      const result = await setCapabilityActiveAction(capability.id, next)
      setPendingToggles((prev) => {
        const copy = { ...prev }
        delete copy[capability.id]
        return copy
      })

      if (result.isSuccess) {
        toast({
          title: "Success",
          description: next
            ? `Enabled ${capability.name}`
            : `Disabled ${capability.name}`,
        })
      } else {
        toast({
          title: "Error",
          description: result.message,
          variant: "destructive",
        })
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Capabilities</h2>
          <p className="text-sm text-muted-foreground">
            Role-gated feature flags. Code capabilities are managed by the app
            manifest; only their role assignment is editable.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New Capability</Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Identifier</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[110px]">Active</TableHead>
            <TableHead className="w-[160px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {capabilities.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                No capabilities found.
              </TableCell>
            </TableRow>
          ) : (
            capabilities.map((capability) => {
              const isCode = capability.source === "code"
              const isToggling = pendingToggles[capability.id] === true
              return (
                <TableRow key={capability.id}>
                  <TableCell className="font-medium">{capability.name}</TableCell>
                  <TableCell>
                    <code className="text-xs">{capability.identifier}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={isCode ? "secondary" : "outline"}>
                      {isCode ? "code" : "manual"}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {capability.description}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={capability.isActive}
                      disabled={isToggling}
                      onCheckedChange={() => handleToggleActive(capability)}
                      aria-label={
                        capability.isActive
                          ? `Disable ${capability.name}`
                          : `Enable ${capability.name}`
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(capability)}
                        title={
                          isCode
                            ? "View capability (name/description read-only)"
                            : "Edit capability"
                        }
                      >
                        <IconEdit size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAssigning(capability)}
                        title="Manage role assignments"
                      >
                        <IconUsersGroup size={16} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>

      {(creating || editing) && (
        <CapabilityForm
          capability={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}

      {assigning && (
        <CapabilityRoleAssignments
          capability={assigning}
          roles={roles}
          onClose={() => setAssigning(null)}
        />
      )}
    </div>
  )
}
