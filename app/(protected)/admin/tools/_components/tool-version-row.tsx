"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TableCell, TableRow } from "@/components/ui/table"
import type { ToolVersionWithUsage } from "@/lib/db/drizzle"

/** Stable `YYYY-MM-DD` from a Date|string (avoids locale hydration mismatch). */
export function formatDate(value: Date | string | null): string {
  if (!value) return "—"
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toISOString().slice(0, 10)
}

/** True when a deprecated version is at/past its removal date. */
export function isPastRemoval(removalDate: Date | string | null): boolean {
  if (!removalDate) return false
  const date = removalDate instanceof Date ? removalDate : new Date(removalDate)
  if (Number.isNaN(date.getTime())) return false
  return date.getTime() <= Date.now()
}

interface ToolVersionRowProps {
  row: ToolVersionWithUsage
  onDeprecate: (row: ToolVersionWithUsage) => void
  onRestore: (row: ToolVersionWithUsage) => void
  onRemove: (row: ToolVersionWithUsage) => void
}

/** A single version row in the admin version-history table. */
export function ToolVersionRow({
  row,
  onDeprecate,
  onRestore,
  onRemove,
}: ToolVersionRowProps) {
  const deprecated = row.deprecatedAt != null
  const isCode = row.source === "code"
  const removable = !isCode && isPastRemoval(row.removalDate)
  const totalUsage = row.usage.skillCount + row.usage.assistantPromptCount

  return (
    <TableRow>
      <TableCell className="font-medium">{row.version}</TableCell>
      <TableCell>
        <Badge variant={isCode ? "secondary" : "outline"}>{row.source}</Badge>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground tabular-nums">
        {formatDate(row.createdAt)}
      </TableCell>
      <TableCell>
        {deprecated ? (
          <Badge variant="destructive">
            {isPastRemoval(row.removalDate)
              ? "deprecated (removable)"
              : "deprecated"}
          </Badge>
        ) : row.isActive ? (
          <Badge variant="outline">active</Badge>
        ) : (
          <Badge variant="secondary">disabled</Badge>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {row.replacedBy ? <code>{row.replacedBy}</code> : "—"}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground tabular-nums">
        {formatDate(row.removalDate)}
      </TableCell>
      <TableCell
        className="text-right text-sm tabular-nums"
        title={`${row.usage.skillCount} skills, ${row.usage.assistantPromptCount} assistant prompts`}
      >
        {totalUsage}
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          {!deprecated && (
            <Button variant="ghost" size="sm" onClick={() => onDeprecate(row)}>
              Deprecate
            </Button>
          )}
          {deprecated && (
            <Button variant="ghost" size="sm" onClick={() => onRestore(row)}>
              Restore
            </Button>
          )}
          {!isCode && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={!removable}
              title={
                removable
                  ? "Remove this version"
                  : "Deprecate and wait out the grace period before removing"
              }
              onClick={() => onRemove(row)}
            >
              Remove
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}
