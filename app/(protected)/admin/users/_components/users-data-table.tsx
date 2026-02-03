"use client"

import { useState, useMemo } from "react"
import { useToast } from "@/components/ui/use-toast"
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  SortingState,
  useReactTable,
  ColumnFiltersState,
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
import { Checkbox } from "@/components/ui/checkbox"
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
  IconEye,
  IconMail,
} from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import { formatDate } from "@/lib/date-utils"
import { UserAvatar } from "./user-avatar"
import { RoleBadgeList } from "./role-badge"
import { StatusIndicator, type UserStatus } from "./status-indicator"

// Extended user type for the table
export interface UserTableRow {
  id: number
  firstName: string
  lastName: string
  email: string
  avatarUrl?: string | null
  roles: string[]
  status: UserStatus
  lastSignInAt?: string | null
  createdAt?: string | null
}

interface UsersDataTableProps {
  users: UserTableRow[]
  onViewUser: (user: UserTableRow) => void
  onEditUser: (user: UserTableRow) => void
  onDeleteUser: (user: UserTableRow) => void
  onSendInvite?: (user: UserTableRow) => void
  loading?: boolean
  className?: string
}

// Sortable column header component
function SortableHeader({
  column,
  title,
}: {
  column: { getIsSorted: () => "asc" | "desc" | false; toggleSorting: (desc?: boolean) => void }
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

export function UsersDataTable({
  users,
  onViewUser,
  onEditUser,
  onDeleteUser,
  onSendInvite,
  loading = false,
  className,
}: UsersDataTableProps) {
  const { toast } = useToast()
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [rowSelection, setRowSelection] = useState({})

  // Create columns with actions
  const columns = useMemo<ColumnDef<UserTableRow>[]>(
    () => [
      // Selection checkbox
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Select row"
          />
        ),
        enableSorting: false,
        enableHiding: false,
        size: 40,
      },
      // User column (avatar + name + email)
      {
        id: "user",
        accessorFn: (row) => `${row.firstName} ${row.lastName}`,
        header: ({ column }) => <SortableHeader column={column} title="User" />,
        cell: ({ row }) => {
          const user = row.original
          const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || "(No name)"

          return (
            <div className="flex items-center gap-3">
              <UserAvatar
                firstName={user.firstName}
                lastName={user.lastName}
                email={user.email}
                avatarUrl={user.avatarUrl}
                status={user.status}
                size="md"
                showStatusIndicator
              />
              <div className="min-w-0">
                <p className="font-medium text-sm truncate">{fullName}</p>
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              </div>
            </div>
          )
        },
        size: 280,
      },
      // Roles column
      {
        accessorKey: "roles",
        header: "Role",
        cell: ({ row }) => <RoleBadgeList roles={row.original.roles} maxDisplay={2} />,
        size: 160,
      },
      // Status column
      {
        accessorKey: "status",
        header: ({ column }) => <SortableHeader column={column} title="Status" />,
        cell: ({ row }) => (
          <StatusIndicator status={row.original.status} size="sm" />
        ),
        size: 120,
      },
      // Last Active column
      {
        accessorKey: "lastSignInAt",
        header: ({ column }) => <SortableHeader column={column} title="Last Active" />,
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatDate(row.original.lastSignInAt)}
          </span>
        ),
        size: 120,
      },
      // Actions column
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const user = row.original

          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <IconDotsVertical className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onViewUser(user)}>
                  <IconEye className="mr-2 h-4 w-4" />
                  View Details
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onEditUser(user)}>
                  <IconEdit className="mr-2 h-4 w-4" />
                  Edit User
                </DropdownMenuItem>
                {user.status === "pending" && onSendInvite && (
                  <DropdownMenuItem onClick={() => onSendInvite(user)}>
                    <IconMail className="mr-2 h-4 w-4" />
                    Resend Invite
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDeleteUser(user)}
                  className="text-destructive focus:text-destructive"
                >
                  <IconTrash className="mr-2 h-4 w-4" />
                  Delete User
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
        size: 60,
      },
    ],
    [onViewUser, onEditUser, onDeleteUser, onSendInvite]
  )

  const table = useReactTable({
    data: users,
    columns,
    state: {
      sorting,
      columnFilters,
      rowSelection,
    },
    enableRowSelection: true,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  const selectedCount = Object.keys(rowSelection).length

  return (
    <div className={cn("space-y-4", className)}>
      {/* Bulk Actions Bar */}
      {selectedCount > 0 && (
        <div className="flex items-center justify-between px-4 py-2 bg-muted rounded-lg">
          <span className="text-sm font-medium">
            {selectedCount} user{selectedCount !== 1 ? "s" : ""} selected
          </span>
          <Button variant="outline" size="sm" onClick={() => setRowSelection({})}>
            Clear Selection
          </Button>
        </div>
      )}

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
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={async (e) => {
                    // Don't trigger view if clicking on checkbox or dropdown
                    if (
                      (e.target as HTMLElement).closest('[role="checkbox"]') ||
                      (e.target as HTMLElement).closest('[role="menu"]') ||
                      (e.target as HTMLElement).closest("button")
                    ) {
                      return
                    }
                    try {
                      await onViewUser(row.original)
                    } catch {
                      toast({
                        title: "Error",
                        description: "Failed to load user details. Please try again.",
                        variant: "destructive",
                      })
                    }
                  }}
                >
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
                  No users found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Table Footer */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {table.getFilteredRowModel().rows.length} user
          {table.getFilteredRowModel().rows.length !== 1 ? "s" : ""}
        </span>
        {selectedCount > 0 && (
          <span>
            {selectedCount} of {table.getFilteredRowModel().rows.length} row
            {table.getFilteredRowModel().rows.length !== 1 ? "s" : ""} selected
          </span>
        )}
      </div>
    </div>
  )
}
