"use client"

import { useState, useMemo } from "react"
import {
  ColumnDef,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
} from "@tanstack/react-table"
import { useUncompiledReactTable } from "@/components/ui/use-uncompiled-react-table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  IconChevronDown,
  IconChevronUp,
  IconSelector,
  IconEye,
} from "@tabler/icons-react"
import { formatDistanceToNow } from "date-fns"
import type { ComparisonActivityItem } from "@/actions/admin/activity-management.actions"
import { ActivityDataTable } from "./activity-data-table"

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
  "use no memo"

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

  const table = useUncompiledReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <ActivityDataTable
      table={table}
      loading={loading}
      emptyMessage="No model comparisons found"
    />
  )
}
