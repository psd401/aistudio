"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/components/ui/use-toast"
import {
  getCapabilityRoleIdsAction,
  setCapabilityRoleAssignmentAction,
} from "@/actions/admin/capabilities.actions"
import type { CapabilityRow, RoleOption } from "./capabilities-table"

interface CapabilityRoleAssignmentsProps {
  capability: CapabilityRow
  roles: RoleOption[]
  onClose: () => void
}

export function CapabilityRoleAssignments({
  capability,
  roles,
  onClose,
}: CapabilityRoleAssignmentsProps) {
  const { toast } = useToast()
  const [assignedRoleIds, setAssignedRoleIds] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  // Track every in-flight role toggle so rapid clicks on different rows each
  // stay disabled until their own request resolves.
  const [pendingRoleIds, setPendingRoleIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const result = await getCapabilityRoleIdsAction(capability.id)
      if (cancelled) return
      if (result.isSuccess) {
        setAssignedRoleIds(new Set(result.data))
      } else {
        toast({
          title: "Error",
          description: result.message,
          variant: "destructive",
        })
      }
      setLoading(false)
    }

    load()

    return () => {
      cancelled = true
    }
  }, [capability.id, toast])

  const handleToggle = async (roleId: number, nextAssigned: boolean) => {
    setPendingRoleIds((prev) => new Set(prev).add(roleId))
    const result = await setCapabilityRoleAssignmentAction(
      capability.id,
      roleId,
      nextAssigned
    )
    setPendingRoleIds((prev) => {
      const next = new Set(prev)
      next.delete(roleId)
      return next
    })

    if (result.isSuccess) {
      setAssignedRoleIds((prev) => {
        const next = new Set(prev)
        if (nextAssigned) {
          next.add(roleId)
        } else {
          next.delete(roleId)
        }
        return next
      })
    } else {
      toast({
        title: "Error",
        description: result.message,
        variant: "destructive",
      })
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Role assignments — {capability.name}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="text-sm text-muted-foreground">Loading roles...</div>
        ) : (
          <div className="space-y-2">
            {roles.map((role) => {
              const checked = assignedRoleIds.has(role.id)
              return (
                <label
                  key={role.id}
                  className="flex items-center gap-2 rounded-md p-2 hover:bg-muted"
                >
                  <Checkbox
                    checked={checked}
                    disabled={pendingRoleIds.has(role.id)}
                    onCheckedChange={(value) =>
                      handleToggle(role.id, value === true)
                    }
                  />
                  <span className="text-sm">{role.name}</span>
                </label>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
