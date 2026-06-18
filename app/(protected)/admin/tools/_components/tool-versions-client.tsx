"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useToast } from "@/components/ui/use-toast"
import {
  getToolVersionHistoryAction,
  undeprecateToolVersionAction,
  removeToolVersionAction,
  type ToolIdentifierSummary,
} from "@/actions/admin/tool-versions.actions"
import type { ToolVersionWithUsage } from "@/lib/db/drizzle"
import { DeprecateVersionDialog } from "./deprecate-version-dialog"
import { ToolVersionRow } from "./tool-version-row"

interface ToolVersionsClientProps {
  identifiers: ToolIdentifierSummary[]
}

export function ToolVersionsClient({ identifiers }: ToolVersionsClientProps) {
  const { toast } = useToast()
  const [selected, setSelected] = useState<string | null>(
    identifiers[0]?.identifier ?? null
  )
  const [versions, setVersions] = useState<ToolVersionWithUsage[]>([])
  const [loading, setLoading] = useState(false)
  const [deprecating, setDeprecating] = useState<ToolVersionWithUsage | null>(null)
  const [, startTransition] = useTransition()
  // Tracks the latest requested identifier so a slow earlier response cannot
  // overwrite a newer selection's data (stale-response guard).
  const latestRequest = useRef<string | null>(null)

  const loadVersions = useCallback(
    (identifier: string) => {
      latestRequest.current = identifier
      startTransition(async () => {
        setLoading(true)
        const result = await getToolVersionHistoryAction(identifier)
        // Ignore a response that is no longer for the current selection.
        if (latestRequest.current !== identifier) return
        setLoading(false)
        if (result.isSuccess) {
          setVersions(result.data)
        } else {
          toast({ title: "Error", description: result.message, variant: "destructive" })
          setVersions([])
        }
      })
    },
    [toast]
  )

  // Reload whenever the selected tool changes. The effect only schedules a
  // transition (no synchronous setState in the effect body).
  useEffect(() => {
    if (selected) {
      loadVersions(selected)
    } else {
      latestRequest.current = null
      startTransition(() => setVersions([]))
    }
  }, [selected, loadVersions])

  const handleRestore = useCallback(
    (row: ToolVersionWithUsage) => {
      startTransition(async () => {
        const result = await undeprecateToolVersionAction(row.identifier, row.version)
        if (result.isSuccess) {
          toast({ title: "Restored", description: `${row.identifier}@${row.version}` })
          if (selected) loadVersions(selected)
        } else {
          toast({ title: "Error", description: result.message, variant: "destructive" })
        }
      })
    },
    [selected, loadVersions, toast]
  )

  const handleRemove = useCallback(
    (row: ToolVersionWithUsage) => {
      const ref = `${row.identifier}@${row.version}`
      const confirmed = window.confirm(
        `Permanently remove ${ref}? Skills/assistants pinned to this version will fail with a clear error. This cannot be undone.`
      )
      if (!confirmed) return
      startTransition(async () => {
        const result = await removeToolVersionAction({
          identifier: row.identifier,
          version: row.version,
        })
        if (result.isSuccess) {
          toast({ title: "Removed", description: ref })
          if (selected) loadVersions(selected)
        } else {
          toast({ title: "Error", description: result.message, variant: "destructive" })
        }
      })
    },
    [selected, loadVersions, toast]
  )

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[280px_1fr]">
      <ToolList
        identifiers={identifiers}
        selected={selected}
        onSelect={setSelected}
      />

      <div className="space-y-4">
        <h2 className="text-xl font-semibold">
          {selected ? <code className="text-base">{selected}</code> : "Select a tool"}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Published</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Replaced by</TableHead>
              <TableHead>Removal date</TableHead>
              <TableHead className="text-right">Usage</TableHead>
              <TableHead className="w-[220px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : versions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  No versions.
                </TableCell>
              </TableRow>
            ) : (
              versions.map((row) => (
                <ToolVersionRow
                  key={`${row.identifier}@${row.version}`}
                  row={row}
                  onDeprecate={setDeprecating}
                  onRestore={handleRestore}
                  onRemove={handleRemove}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {deprecating && (
        <DeprecateVersionDialog
          version={deprecating}
          onClose={(didChange) => {
            setDeprecating(null)
            if (didChange && selected) loadVersions(selected)
          }}
        />
      )}
    </div>
  )
}

interface ToolListProps {
  identifiers: ToolIdentifierSummary[]
  selected: string | null
  onSelect: (identifier: string) => void
}

/** Left-hand tool identifier list with version + deprecation counts. */
function ToolList({ identifiers, selected, onSelect }: ToolListProps) {
  return (
    <div className="space-y-1">
      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Tools</h2>
      {identifiers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tools in the catalog.</p>
      ) : (
        identifiers.map((tool) => (
          <button
            key={tool.identifier}
            type="button"
            onClick={() => onSelect(tool.identifier)}
            className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors ${
              selected === tool.identifier
                ? "bg-muted font-medium"
                : "hover:bg-muted/50"
            }`}
          >
            <code className="text-xs">{tool.identifier}</code>
            <span className="flex gap-1">
              <Badge variant="outline">{tool.versionCount}</Badge>
              {tool.deprecatedCount > 0 && (
                <Badge variant="secondary">{tool.deprecatedCount} dep.</Badge>
              )}
            </span>
          </button>
        ))
      )}
    </div>
  )
}
