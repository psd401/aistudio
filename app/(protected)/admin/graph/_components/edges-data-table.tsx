"use client"

import { useState, useMemo } from "react"
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  IconChevronDown,
  IconChevronUp,
  IconSelector,
  IconDotsVertical,
  IconTrash,
  IconArrowRight,
} from "@tabler/icons-react"
import { cn } from "@/lib/utils"

export interface EdgeTableRow {
  id: string
  sourceNodeId: string
  sourceNodeName: string
  targetNodeId: string
  targetNodeName: string
  edgeType: string
  createdAt: Date | null
}

interface EdgesDataTableProps {
  edges: EdgeTableRow[]
  onDeleteEdge: (edge: EdgeTableRow) => void
  loading?: boolean
  className?: string
}

function SortableHeader({
  column,
  title,
}: {
  column: {
    getIsSorted: () => "asc" | "desc" | false
    toggleSorting: (desc?: boolean) => void
  }
  title: string
}) {
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

export function EdgesDataTable({
  edges,
  onDeleteEdge,
  loading = false,
  className,
}: EdgesDataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([])

  const columns = useMemo<ColumnDef<EdgeTableRow>[]>(
    () => [
      {
        accessorKey: "sourceNodeName",
        header: ({ column }) => (
          <SortableHeader column={column} title="Source Node" />
        ),
        cell: ({ row }) => (
          <div className="font-medium">{row.original.sourceNodeName}</div>
        ),
        size: 200,
      },
      {
        id: "direction",
        header: () => null,
        cell: () => (
          <IconArrowRight className="h-4 w-4 text-muted-foreground" />
        ),
        size: 40,
      },
      {
        accessorKey: "edgeType",
        header: ({ column }) => (
          <SortableHeader column={column} title="Edge Type" />
        ),
        cell: ({ row }) => (
          <Badge variant="outline">{row.original.edgeType}</Badge>
        ),
        size: 160,
      },
      {
        id: "direction2",
        header: () => null,
        cell: () => (
          <IconArrowRight className="h-4 w-4 text-muted-foreground" />
        ),
        size: 40,
      },
      {
        accessorKey: "targetNodeName",
        header: ({ column }) => (
          <SortableHeader column={column} title="Target Node" />
        ),
        cell: ({ row }) => (
          <div className="font-medium">{row.original.targetNodeName}</div>
        ),
        size: 200,
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <SortableHeader column={column} title="Created" />
        ),
        cell: ({ row }) => {
          const date = row.original.createdAt
          if (!date) return <span className="text-muted-foreground">—</span>
          return (
            <span className="text-sm text-muted-foreground">
              {new Date(date).toLocaleDateString()}
            </span>
          )
        },
        size: 120,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const edge = row.original
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <IconDotsVertical className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => onDeleteEdge(edge)}
                  className="text-destructive focus:text-destructive"
                >
                  <IconTrash className="mr-2 h-4 w-4" />
                  Delete Edge
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
        size: 60,
      },
    ],
    [onDeleteEdge]
  )

  const table = useReactTable({
    data: edges,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className={cn("space-y-4", className)}>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="bg-muted/50 hover:bg-muted/50"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className="h-11"
                  >
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
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {columns.map((_, j) => (
                    <TableCell key={j}>
                      <div className="h-4 bg-muted rounded animate-pulse" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className="hover:bg-muted/50">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No edges found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {table.getRowModel().rows.length} edge
          {table.getRowModel().rows.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  )
}
