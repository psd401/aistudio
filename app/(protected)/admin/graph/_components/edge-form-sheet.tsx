"use client"

import { useState, useEffect, useMemo } from "react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { IconSearch } from "@tabler/icons-react"
import type { SelectGraphNode } from "@/lib/db/types"

export interface EdgeFormData {
  sourceNodeId: string
  targetNodeId: string
  edgeType: string
  metadata: string
}

interface EdgeFormSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodes: SelectGraphNode[]
  onSave: (data: EdgeFormData) => Promise<void>
}

const emptyForm: EdgeFormData = {
  sourceNodeId: "",
  targetNodeId: "",
  edgeType: "",
  metadata: "{}",
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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent position="right" size="lg" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Connect Nodes</SheetTitle>
          <SheetDescription>
            Create an edge between two graph nodes.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 py-6">
          <div className="space-y-2">
            <Label>
              Source Node <span className="text-destructive">*</span>
            </Label>
            <div className="space-y-2">
              <div className="relative">
                <Input
                  placeholder="Search nodes..."
                  value={sourceSearch}
                  onChange={(e) => setSourceSearch(e.target.value)}
                  icon={<IconSearch className="h-4 w-4" />}
                  className="w-full"
                />
              </div>
              <Select
                value={form.sourceNodeId}
                onValueChange={(value) =>
                  setForm((prev) => ({ ...prev, sourceNodeId: value }))
                }
              >
                <SelectTrigger aria-label="Select source node">
                  <SelectValue placeholder="Select source node..." />
                </SelectTrigger>
                <SelectContent>
                  {filteredSourceNodes.length === 0 ? (
                    <div className="py-2 px-3 text-sm text-muted-foreground">
                      No nodes found
                    </div>
                  ) : (
                    filteredSourceNodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        <span className="font-medium">{node.name}</span>
                        <span className="ml-2 text-muted-foreground text-xs">
                          ({node.nodeType})
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edge-type">
              Edge Type <span className="text-destructive">*</span>
            </Label>
            <Input
              id="edge-type"
              placeholder="e.g., informs, depends_on, supersedes"
              value={form.edgeType}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, edgeType: e.target.value }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label>
              Target Node <span className="text-destructive">*</span>
            </Label>
            <div className="space-y-2">
              <div className="relative">
                <Input
                  placeholder="Search nodes..."
                  value={targetSearch}
                  onChange={(e) => setTargetSearch(e.target.value)}
                  icon={<IconSearch className="h-4 w-4" />}
                  className="w-full"
                />
              </div>
              <Select
                value={form.targetNodeId}
                onValueChange={(value) =>
                  setForm((prev) => ({ ...prev, targetNodeId: value }))
                }
              >
                <SelectTrigger aria-label="Select target node">
                  <SelectValue placeholder="Select target node..." />
                </SelectTrigger>
                <SelectContent>
                  {filteredTargetNodes.length === 0 ? (
                    <div className="py-2 px-3 text-sm text-muted-foreground">
                      No nodes found
                    </div>
                  ) : (
                    filteredTargetNodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        <span className="font-medium">{node.name}</span>
                        <span className="ml-2 text-muted-foreground text-xs">
                          ({node.nodeType})
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edge-metadata">Metadata (JSON, optional)</Label>
            <Textarea
              id="edge-metadata"
              placeholder='{"key": "value"}'
              value={form.metadata}
              onChange={(e) => handleMetadataChange(e.target.value)}
              rows={3}
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
            {saving ? "Connecting..." : "Connect Nodes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
