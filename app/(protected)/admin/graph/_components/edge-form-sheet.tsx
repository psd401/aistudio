"use client"

import { useState, useEffect, useMemo } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { IconSearch } from "@tabler/icons-react"
import type { PublicGraphNode } from "@/lib/graph"

export interface EdgeFormData {
  sourceNodeId: string
  targetNodeId: string
  edgeType: string
  metadata: string
}

interface EdgeFormSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodes: PublicGraphNode[]
  onSave: (data: EdgeFormData) => Promise<void>
}

const emptyForm: EdgeFormData = {
  sourceNodeId: "",
  targetNodeId: "",
  edgeType: "",
  metadata: "{}",
}

function GraphNodeSelect({
  label,
  value,
  search,
  nodes,
  onSearchChange,
  onValueChange,
}: {
  label: "Source" | "Target"
  value: string
  search: string
  nodes: PublicGraphNode[]
  onSearchChange: (value: string) => void
  onValueChange: (value: string) => void
}) {
  const lowerLabel = label.toLowerCase()
  return (
    <div className="space-y-2">
      <Label>
        {label} Node <span className="text-destructive">*</span>
      </Label>
      <div className="space-y-2">
        <Input
          placeholder="Search nodes..."
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          icon={<IconSearch className="h-4 w-4" />}
          className="w-full"
        />
        <Select value={value} onValueChange={onValueChange}>
          <SelectTrigger aria-label={`Select ${lowerLabel} node`}>
            <SelectValue placeholder={`Select ${lowerLabel} node...`} />
          </SelectTrigger>
          <SelectContent>
            {nodes.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No nodes found
              </div>
            ) : (
              nodes.map((node) => (
                <SelectItem key={node.id} value={node.id}>
                  <span className="font-medium">{node.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({node.nodeType})
                  </span>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

function EdgeFormFields({
  form,
  sourceSearch,
  targetSearch,
  sourceNodes,
  targetNodes,
  metadataError,
  onChange,
  onSourceSearchChange,
  onTargetSearchChange,
  onMetadataChange,
}: {
  form: EdgeFormData
  sourceSearch: string
  targetSearch: string
  sourceNodes: PublicGraphNode[]
  targetNodes: PublicGraphNode[]
  metadataError: string | null
  onChange: (updates: Partial<EdgeFormData>) => void
  onSourceSearchChange: (value: string) => void
  onTargetSearchChange: (value: string) => void
  onMetadataChange: (value: string) => void
}) {
  return (
    <div className="space-y-4 pb-4">
      <GraphNodeSelect
        label="Source"
        value={form.sourceNodeId}
        search={sourceSearch}
        nodes={sourceNodes}
        onSearchChange={onSourceSearchChange}
        onValueChange={(sourceNodeId) => onChange({ sourceNodeId })}
      />
      <div className="space-y-2">
        <Label htmlFor="edge-type">
          Edge Type <span className="text-destructive">*</span>
        </Label>
        <Input
          id="edge-type"
          placeholder="e.g., informs, depends_on, supersedes"
          value={form.edgeType}
          onChange={(event) => onChange({ edgeType: event.target.value })}
        />
      </div>
      <GraphNodeSelect
        label="Target"
        value={form.targetNodeId}
        search={targetSearch}
        nodes={targetNodes}
        onSearchChange={onTargetSearchChange}
        onValueChange={(targetNodeId) => onChange({ targetNodeId })}
      />
      <div className="space-y-2">
        <Label htmlFor="edge-metadata">Metadata (JSON, optional)</Label>
        <Textarea
          id="edge-metadata"
          placeholder='{"key": "value"}'
          value={form.metadata}
          onChange={(event) => onMetadataChange(event.target.value)}
          rows={3}
          className={metadataError ? "border-destructive" : "font-mono text-sm"}
        />
        {metadataError && (
          <p className="text-xs text-destructive">{metadataError}</p>
        )}
      </div>
    </div>
  )
}

export function EdgeFormSheet({
  open,
  onOpenChange,
  nodes,
  onSave,
}: EdgeFormSheetProps) {
  const [form, setForm] = useState<EdgeFormData>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [sourceSearch, setSourceSearch] = useState("")
  const [targetSearch, setTargetSearch] = useState("")

  useEffect(() => {
    if (open) {
      setForm(emptyForm)
      setMetadataError(null)
      setSourceSearch("")
      setTargetSearch("")
    }
  }, [open])

  const filteredSourceNodes = useMemo(() => {
    if (!sourceSearch) return nodes
    const q = sourceSearch.toLowerCase()
    return nodes.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.nodeType.toLowerCase().includes(q)
    )
  }, [nodes, sourceSearch])

  const filteredTargetNodes = useMemo(() => {
    const filtered = form.sourceNodeId
      ? nodes.filter((n) => n.id !== form.sourceNodeId)
      : nodes
    if (!targetSearch) return filtered
    const q = targetSearch.toLowerCase()
    return filtered.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.nodeType.toLowerCase().includes(q)
    )
  }, [nodes, form.sourceNodeId, targetSearch])

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
    if (
      !form.sourceNodeId ||
      !form.targetNodeId ||
      !form.edgeType.trim()
    ) {
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
    form.sourceNodeId !== "" &&
    form.targetNodeId !== "" &&
    form.edgeType.trim() !== "" &&
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
        >
          {/* Close button */}
          <Dialog.Close className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <XIcon className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Dialog.Close>

          {/* Header */}
          <div className="flex-shrink-0 px-6 pt-6 pb-4">
            <Dialog.Title className="text-xl font-semibold leading-none">
              Connect Nodes
            </Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground mt-1">
              Create an edge between two graph nodes.
            </Dialog.Description>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6">
            <EdgeFormFields
              form={form}
              sourceSearch={sourceSearch}
              targetSearch={targetSearch}
              sourceNodes={filteredSourceNodes}
              targetNodes={filteredTargetNodes}
              metadataError={metadataError}
              onChange={(updates) =>
                setForm((previous) => ({ ...previous, ...updates }))
              }
              onSourceSearchChange={setSourceSearch}
              onTargetSearchChange={setTargetSearch}
              onMetadataChange={handleMetadataChange}
            />
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
              {saving ? "Connecting..." : "Connect Nodes"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
