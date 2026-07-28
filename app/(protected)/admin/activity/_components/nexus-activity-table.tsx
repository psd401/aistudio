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
import type { NexusActivityItem } from "@/actions/admin/activity-management.actions"
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

interface NexusActivityTableProps {
  data: NexusActivityItem[]
  loading?: boolean
  onViewDetail: (item: NexusActivityItem) => void
}

export function NexusActivityTable({
  data,
  loading,
  onViewDetail,
}: NexusActivityTableProps) {
  "use no memo"

  const [sorting, setSorting] = useState<SortingState>([
    { id: "lastMessageAt", desc: true },
  ])

  const columns = useMemo<ColumnDef<NexusActivityItem>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <SortableHeader column={column} title="Title" />,
        cell: ({ row }) => (
          <div className="max-w-xs">
            <p className="font-medium truncate">
              {row.original.title || "Untitled Conversation"}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              ID: {row.original.id.slice(0, 8)}...
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
        accessorKey: "provider",
        header: "Provider",
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.provider}</Badge>
        ),
      },
      {
        accessorKey: "modelUsed",
        header: "Model",
        cell: ({ row }) => (
          <span className="text-sm">{row.original.modelUsed || "—"}</span>
        ),
      },
      {
        accessorKey: "messageCount",
        header: ({ column }) => (
          <SortableHeader column={column} title="Messages" />
        ),
        cell: ({ row }) => row.original.messageCount?.toLocaleString() ?? 0,
      },
      {
        accessorKey: "totalTokens",
        header: ({ column }) => (
          <SortableHeader column={column} title="Tokens" />
        ),
        cell: ({ row }) => row.original.totalTokens?.toLocaleString() ?? 0,
      },
      {
        accessorKey: "costUsd",
        header: ({ column }) => (
          <SortableHeader column={column} title="Cost" />
        ),
        cell: ({ row }) => {
          const cost = row.original.costUsd ?? 0
          return cost > 0
            ? new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: "USD",
                minimumFractionDigits: 4,
                maximumFractionDigits: 4,
              }).format(cost)
            : "$0.00"
        },
      },
      {
        accessorKey: "lastMessageAt",
        header: ({ column }) => (
          <SortableHeader column={column} title="Last Activity" />
        ),
        cell: ({ row }) => {
          const date = row.original.lastMessageAt
          return date ? formatDistanceToNow(new Date(date), { addSuffix: true }) : "—"
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
      emptyMessage="No Nexus conversations found"
    />
  )
}
