"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  const [removing, setRemoving] = useState<ToolVersionWithUsage | null>(null)
  const [, startTransition] = useTransition()
  // Tracks the latest requested identifier so a slow earlier response cannot
  // overwrite a newer selection's data (stale-response guard).
  const latestRequest = useRef<string | null>(null)

  const loadVersions = useCallback(
    (identifier: string) => {
      latestRequest.current = identifier
      startTransition(async () => {
        setLoading(true)
        try {
          const result = await getToolVersionHistoryAction(identifier)
          // Ignore a response that is no longer for the current selection.
          if (latestRequest.current !== identifier) return
          if (result.isSuccess) {
            setVersions(result.data)
          } else {
            toast({ title: "Error", description: result.message, variant: "destructive" })
            setVersions([])
          }
        } finally {
          // Only clear the spinner if this response is still current, so a stale
          // response from a previous selection never clears a live in-flight load.
          if (latestRequest.current === identifier) setLoading(false)
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
      // Open the AlertDialog for confirmation instead of using window.confirm
      // (which blocks the main thread and can be suppressed in sandboxed contexts).
      setRemoving(row)
    },
    []
  )

  const confirmRemove = useCallback(
    (row: ToolVersionWithUsage) => {
      const ref = `${row.identifier}@${row.version}`
      setRemoving(null)
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

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removing ? `${removing.identifier}@${removing.version}` : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the version. Skills and assistants pinned to it
              will fail with a clear error. This action cannot be undone.
              {removing &&
                removing.usage.skillCount + removing.usage.assistantPromptCount > 0 && (
                  <span className="mt-2 block font-medium text-destructive">
                    Currently referenced by {removing.usage.skillCount} skill(s) and{" "}
                    {removing.usage.assistantPromptCount} assistant prompt(s).
                  </span>
                )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => removing && confirmRemove(removing)}
            >
              Remove permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
