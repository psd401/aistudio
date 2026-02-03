"use client"

import { useState, useEffect, useRef } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"
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
  const firstInputRef = useRef<HTMLInputElement>(null)

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="rounded-lg border bg-background shadow-lg p-0 flex flex-col data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "min(95vw, 640px)",
            maxWidth: "min(95vw, 640px)",
            maxHeight: "85vh",
            zIndex: 50,
          }}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            firstInputRef.current?.focus()
          }}
        >
          {/* Close button */}
          <Dialog.Close className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <XIcon className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Dialog.Close>

          {/* Header */}
          <div className="flex-shrink-0 px-6 pt-6 pb-4">
            <Dialog.Title className="text-xl font-semibold leading-none">
              {isEditing ? "Edit Node" : "Create Node"}
            </Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground mt-1">
              {isEditing
                ? "Update the node properties below."
                : "Fill in the details to create a new graph node."}
            </Dialog.Description>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6">
            <div className="space-y-4 pb-4">
              <div className="space-y-2">
                <Label htmlFor="node-name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  ref={firstInputRef}
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
                      setForm((prev) => ({
                        ...prev,
                        nodeType: e.target.value,
                      }))
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
                      setForm((prev) => ({
                        ...prev,
                        nodeClass: e.target.value,
                      }))
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
                    setForm((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
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
                  className={
                    metadataError
                      ? "border-destructive"
                      : "font-mono text-sm"
                  }
                />
                {metadataError && (
                  <p className="text-xs text-destructive">{metadataError}</p>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex-shrink-0 flex justify-end gap-2 px-6 py-4 border-t">
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
