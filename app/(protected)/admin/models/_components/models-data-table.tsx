"use client"

import { useState, useMemo } from "react"
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
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
import { Switch } from "@/components/ui/switch"
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
  IconEdit,
  IconTrash,
} from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import { ProviderBadge } from "./provider-badge"

// Extended model type for the table
export interface ModelTableRow {
  id: number
  name: string
  provider: string
  modelId: string
  description?: string | null
  active: boolean
  nexusEnabled: boolean
  architectEnabled: boolean
}

interface ModelsDataTableProps {
  models: ModelTableRow[]
  onViewModel: (model: ModelTableRow) => void
  onToggleActive: (modelId: number, active: boolean) => void
  onToggleNexus: (modelId: number, enabled: boolean) => void
  onToggleArchitect: (modelId: number, enabled: boolean) => void
  onDeleteModel: (model: ModelTableRow) => void
  loading?: boolean
  loadingToggles?: Set<number>
  className?: string
}

// Sortable column header component
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

export function ModelsDataTable({
  models,
  onViewModel,
  onToggleActive,
  onToggleNexus,
  onToggleArchitect,
  onDeleteModel,
  loading = false,
  loadingToggles,
  className,
}: ModelsDataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([])

  // Create columns with actions
  const columns = useMemo<ColumnDef<ModelTableRow>[]>(
    () => [
      // Name column
      {
        accessorKey: "name",
        header: ({ column }) => <SortableHeader column={column} title="Name" />,
        cell: ({ row }) => (
          <div className="font-medium">{row.original.name}</div>
        ),
        size: 200,
      },
      // Provider column
      {
        accessorKey: "provider",
        header: ({ column }) => <SortableHeader column={column} title="Provider" />,
        cell: ({ row }) => <ProviderBadge provider={row.original.provider} />,
        size: 120,
      },
      // Model ID column
      {
        accessorKey: "modelId",
        header: ({ column }) => <SortableHeader column={column} title="Model ID" />,
        cell: ({ row }) => (
          <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
            {row.original.modelId}
          </code>
        ),
        size: 200,
      },
      // Active column
      {
        accessorKey: "active",
        header: "Active",
        cell: ({ row }) => (
          <Switch
            checked={row.original.active}
            onCheckedChange={(checked) => onToggleActive(row.original.id, checked)}
            disabled={loadingToggles?.has(row.original.id)}
            aria-label={`Toggle active for ${row.original.name}`}
            aria-busy={loadingToggles?.has(row.original.id)}
          />
        ),
        size: 80,
      },
      // Nexus Enabled column
      {
        accessorKey: "nexusEnabled",
        header: "Nexus",
        cell: ({ row }) => (
          <Switch
            checked={row.original.nexusEnabled}
            onCheckedChange={(checked) => onToggleNexus(row.original.id, checked)}
            disabled={loadingToggles?.has(row.original.id)}
            aria-label={`Toggle Nexus for ${row.original.name}`}
            aria-busy={loadingToggles?.has(row.original.id)}
          />
        ),
        size: 80,
      },
      // Architect Enabled column
      {
        accessorKey: "architectEnabled",
        header: "Architect",
        cell: ({ row }) => (
          <Switch
            checked={row.original.architectEnabled}
            onCheckedChange={(checked) => onToggleArchitect(row.original.id, checked)}
            disabled={loadingToggles?.has(row.original.id)}
            aria-label={`Toggle Architect for ${row.original.name}`}
            aria-busy={loadingToggles?.has(row.original.id)}
          />
        ),
        size: 80,
      },
      // Actions column
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const model = row.original

          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <IconDotsVertical className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onViewModel(model)}>
                  <IconEdit className="mr-2 h-4 w-4" />
                  Edit Model
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDeleteModel(model)}
                  className="text-destructive focus:text-destructive"
                >
                  <IconTrash className="mr-2 h-4 w-4" />
                  Delete Model
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
        size: 60,
      },
    ],
    [onViewModel, onToggleActive, onToggleNexus, onToggleArchitect, onDeleteModel, loadingToggles]
  )

  const table = useReactTable({
    data: models,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  return (
    <div className={cn("space-y-4", className)}>
      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="bg-muted/50 hover:bg-muted/50">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className="h-11"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              // Loading skeleton
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
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No models found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Table Footer */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {table.getFilteredRowModel().rows.length} model
          {table.getFilteredRowModel().rows.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  )
}
