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
import type { NexusActivityItem } from "@/actions/admin/activity-management.actions"

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
        No Nexus conversations found
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
