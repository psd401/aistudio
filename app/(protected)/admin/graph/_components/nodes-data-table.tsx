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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  IconChevronDown,
  IconChevronUp,
  IconSelector,
  IconDotsVertical,
  IconEye,
  IconEdit,
  IconTrash,
} from "@tabler/icons-react"
import { cn } from "@/lib/utils"

export interface NodeTableRow {
  id: string
  name: string
  nodeType: string
  nodeClass: string
  description: string | null
  createdAt: Date | null
}

interface NodesDataTableProps {
  nodes: NodeTableRow[]
  onViewNode: (node: NodeTableRow) => void
  onEditNode: (node: NodeTableRow) => void
  onDeleteNode: (node: NodeTableRow) => void
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

export function NodesDataTable({
  nodes,
  onViewNode,
  onEditNode,
  onDeleteNode,
  loading = false,
  className,
}: NodesDataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([])

  const columns = useMemo<ColumnDef<NodeTableRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => (
          <SortableHeader column={column} title="Name" />
        ),
        cell: ({ row }) => (
          <div className="font-medium">{row.original.name}</div>
        ),
        size: 220,
      },
      {
        accessorKey: "nodeType",
        header: ({ column }) => (
          <SortableHeader column={column} title="Type" />
        ),
        cell: ({ row }) => (
          <Badge variant="outline">{row.original.nodeType}</Badge>
        ),
        size: 140,
      },
      {
        accessorKey: "nodeClass",
        header: ({ column }) => (
          <SortableHeader column={column} title="Class" />
        ),
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.nodeClass}</Badge>
        ),
        size: 140,
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
          const node = row.original
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <IconDotsVertical className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onViewNode(node)}>
                  <IconEye className="mr-2 h-4 w-4" />
                  View Details
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onEditNode(node)}>
                  <IconEdit className="mr-2 h-4 w-4" />
                  Edit Node
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDeleteNode(node)}
                  className="text-destructive focus:text-destructive"
                >
                  <IconTrash className="mr-2 h-4 w-4" />
                  Delete Node
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
        size: 60,
      },
    ],
    [onViewNode, onEditNode, onDeleteNode]
  )

  const table = useReactTable({
    data: nodes,
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
            ) : table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={(e) => {
                    if (
                      (e.target as HTMLElement).closest("button") ||
                      (e.target as HTMLElement).closest('[role="menuitem"]')
                    ) {
                      return
                    }
                    onViewNode(row.original)
                  }}
                >
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
                  No nodes found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {table.getRowModel().rows.length} node
          {table.getRowModel().rows.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  )
}
