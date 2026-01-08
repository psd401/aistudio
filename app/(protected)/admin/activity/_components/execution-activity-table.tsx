"use client"

import { useState, useMemo } from "react"
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  SortingState,
} from "@tanstack/react-table"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  IconChevronDown,
  IconChevronUp,
  IconSelector,
  IconEye,
} from "@tabler/icons-react"
import { formatDistanceToNow } from "date-fns"
import type { ExecutionActivityItem } from "@/actions/admin/activity-management.actions"

interface SortableHeaderProps {
  column: {
    getIsSorted: () => "asc" | "desc" | false
    toggleSorting: (desc?: boolean) => void
  }
  title: string
}

function SortableHeader({ column, title }: SortableHeaderProps) {
  return (
    <Button
      variant="ghost"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      className="hover:bg-transparent px-0 font-medium"
    >
      {title}
      {column.getIsSorted() === "asc" ? (
        <IconChevronUp className="ml-2 h-4 w-4" />
      ) : column.getIsSorted() === "desc" ? (
        <IconChevronDown className="ml-2 h-4 w-4" />
      ) : (
        <IconSelector className="ml-2 h-4 w-4 text-muted-foreground" />
      )}
    </Button>
  )
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "completed" || status === "success"
      ? "default"
      : status === "error" || status === "failed"
        ? "destructive"
        : status === "running" || status === "in_progress"
          ? "secondary"
          : "outline"

  return <Badge variant={variant}>{status}</Badge>
}

interface ExecutionActivityTableProps {
  data: ExecutionActivityItem[]
  loading?: boolean
  onViewDetail: (item: ExecutionActivityItem) => void
}

export function ExecutionActivityTable({
  data,
  loading,
  onViewDetail,
}: ExecutionActivityTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "executedAt", desc: true },
  ])

  const columns = useMemo<ColumnDef<ExecutionActivityItem>[]>(
    () => [
      {
        accessorKey: "assistantName",
        header: ({ column }) => (
          <SortableHeader column={column} title="Assistant" />
        ),
        cell: ({ row }) => (
          <div className="max-w-xs">
            <p className="font-medium truncate">{row.original.assistantName}</p>
            <p className="text-xs text-muted-foreground truncate">
              {row.original.scheduleName}
            </p>
          </div>
        ),
      },
      {
        accessorKey: "userName",
        header: ({ column }) => <SortableHeader column={column} title="User" />,
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.userName}</p>
            <p className="text-xs text-muted-foreground">
              {row.original.userEmail}
            </p>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: "executionDurationMs",
        header: ({ column }) => (
          <SortableHeader column={column} title="Duration" />
        ),
        cell: ({ row }) => {
          const ms = row.original.executionDurationMs
          if (!ms) return "—"
          if (ms < 1000) return `${ms}ms`
          return `${(ms / 1000).toFixed(1)}s`
        },
      },
      {
        accessorKey: "executedAt",
        header: ({ column }) => (
          <SortableHeader column={column} title="Executed" />
        ),
        cell: ({ row }) => {
          const date = row.original.executedAt
          return date
            ? formatDistanceToNow(new Date(date), { addSuffix: true })
            : "—"
        },
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onViewDetail(row.original)}
          >
            <IconEye className="h-4 w-4" />
          </Button>
        ),
      },
    ],
    [onViewDetail]
  )

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No execution results found
      </div>
    )
  }

  return (
    <div className="border rounded-lg">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
