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
import type { ComparisonActivityItem } from "@/actions/admin/activity-management.actions"

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

interface ComparisonActivityTableProps {
  data: ComparisonActivityItem[]
  loading?: boolean
  onViewDetail: (item: ComparisonActivityItem) => void
}

export function ComparisonActivityTable({
  data,
  loading,
  onViewDetail,
}: ComparisonActivityTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ])

  const columns = useMemo<ColumnDef<ComparisonActivityItem>[]>(
    () => [
      {
        accessorKey: "prompt",
        header: ({ column }) => (
          <SortableHeader column={column} title="Prompt" />
        ),
        cell: ({ row }) => (
          <div className="max-w-sm">
            <p className="font-medium truncate">{row.original.prompt}</p>
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
        accessorKey: "model1Name",
        header: "Model 1",
        cell: ({ row }) => (
          <div>
            <Badge variant="outline">{row.original.model1Name || "—"}</Badge>
            {row.original.tokensUsed1 && (
              <p className="text-xs text-muted-foreground mt-1">
                {row.original.tokensUsed1.toLocaleString()} tokens
              </p>
            )}
          </div>
        ),
      },
      {
        accessorKey: "model2Name",
        header: "Model 2",
        cell: ({ row }) => (
          <div>
            <Badge variant="outline">{row.original.model2Name || "—"}</Badge>
            {row.original.tokensUsed2 && (
              <p className="text-xs text-muted-foreground mt-1">
                {row.original.tokensUsed2.toLocaleString()} tokens
              </p>
            )}
          </div>
        ),
      },
      {
        accessorKey: "costUsd",
        header: ({ column }) => (
          <SortableHeader column={column} title="Cost" />
        ),
        cell: ({ row }) => {
          const cost = row.original.costUsd
          return cost > 0
            ? new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: "USD",
                minimumFractionDigits: 2,
                maximumFractionDigits: 4,
              }).format(cost)
            : "$0.00"
        },
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <SortableHeader column={column} title="Created" />
        ),
        cell: ({ row }) => {
          const date = row.original.createdAt
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
        No model comparisons found
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
