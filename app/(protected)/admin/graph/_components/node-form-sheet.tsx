"use client"

import { useState, useEffect } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import type { SelectGraphNode } from "@/lib/db/types"

export interface NodeFormData {
  name: string
  nodeType: string
  nodeClass: string
  description: string
  metadata: string
}

interface NodeFormSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  node?: SelectGraphNode | null
  onSave: (data: NodeFormData) => Promise<void>
}

const emptyForm: NodeFormData = {
  name: "",
  nodeType: "",
  nodeClass: "",
  description: "",
  metadata: "{}",
}

export function NodeFormSheet({
  open,
  onOpenChange,
  node,
  onSave,
}: NodeFormSheetProps) {
  const [form, setForm] = useState<NodeFormData>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [metadataError, setMetadataError] = useState<string | null>(null)

  const isEditing = !!node

  useEffect(() => {
    if (open) {
      if (node) {
        setForm({
          name: node.name,
          nodeType: node.nodeType,
          nodeClass: node.nodeClass,
          description: node.description || "",
          metadata: node.metadata
            ? JSON.stringify(node.metadata, null, 2)
            : "{}",
        })
      } else {
        setForm(emptyForm)
      }
      setMetadataError(null)
    }
  }, [open, node])

  const handleMetadataChange = (value: string) => {
    setForm((prev) => ({ ...prev, metadata: value }))
    try {
      JSON.parse(value)
      setMetadataError(null)
    } catch {
      setMetadataError("Invalid JSON")
    }
  }

  const handleSave = async () => {
    if (!form.name.trim() || !form.nodeType.trim() || !form.nodeClass.trim()) {
      return
    }
    if (metadataError) return

    setSaving(true)
    try {
      await onSave(form)
      onOpenChange(false)
    } catch {
      // Error handled by parent via toast
    } finally {
      setSaving(false)
    }
  }

  const canSave =
    form.name.trim() !== "" &&
    form.nodeType.trim() !== "" &&
    form.nodeClass.trim() !== "" &&
    !metadataError &&
    !saving

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent position="right" size="lg" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{isEditing ? "Edit Node" : "Create Node"}</SheetTitle>
          <SheetDescription>
            {isEditing
              ? "Update the node properties below."
              : "Fill in the details to create a new graph node."}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 py-6">
          <div className="space-y-2">
            <Label htmlFor="node-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="node-name"
              placeholder="e.g., AI Acceptable Use Policy"
              value={form.name}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, name: e.target.value }))
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="node-type">
                Type <span className="text-destructive">*</span>
              </Label>
              <Input
                id="node-type"
                placeholder="e.g., policy, decision, system"
                value={form.nodeType}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, nodeType: e.target.value }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="node-class">
                Class <span className="text-destructive">*</span>
              </Label>
              <Input
                id="node-class"
                placeholder="e.g., governance, technical"
                value={form.nodeClass}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, nodeClass: e.target.value }))
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="node-description">Description</Label>
            <Textarea
              id="node-description"
              placeholder="Optional description of this node..."
              value={form.description}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, description: e.target.value }))
              }
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="node-metadata">Metadata (JSON)</Label>
            <Textarea
              id="node-metadata"
              placeholder='{"key": "value"}'
              value={form.metadata}
              onChange={(e) => handleMetadataChange(e.target.value)}
              rows={4}
              className={metadataError ? "border-destructive" : "font-mono text-sm"}
            />
            {metadataError && (
              <p className="text-xs text-destructive">{metadataError}</p>
            )}
          </div>
        </div>

        <SheetFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving
              ? "Saving..."
              : isEditing
                ? "Update Node"
                : "Create Node"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
