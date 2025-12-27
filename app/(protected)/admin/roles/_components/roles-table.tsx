"use client"

import React, { useState, useMemo, useCallback } from 'react';
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import {
  ColumnDef,
  Column,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { IconChevronDown, IconChevronUp, IconSelector, IconEdit, IconTool, IconTrash } from '@tabler/icons-react';
import { RoleForm } from "./role-form"
import { ToolAssignments } from "./tool-assignments"
import { useToast } from "@/components/ui/use-toast"

interface Role {
  id: number;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface Tool {
  id: number;
  identifier: string;
  name: string;
  description: string | null;
  promptChainToolId: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface RolesTableProps {
  roles: Role[];
  tools?: Tool[];
}

export function RolesTable({ roles, tools = [] }: RolesTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [editingRole, setEditingRole] = useState<Role | null>(null)
  const [selectedRole, setSelectedRole] = useState<Role | null>(null)
  const [showRoleForm, setShowRoleForm] = useState(false)
  const [showToolAssignments, setShowToolAssignments] = useState(false)
  const { toast } = useToast()
  
  // Memoized column header component to prevent recreation on each render
  const SortableColumnHeader = useCallback(({
    column,
    title,
    className = ""
  }: {
    column: Column<Role>;
    title: string;
    className?: string;
  }) => (
    <Button
      variant="ghost"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      className={`hover:bg-transparent px-0 ${className}`}
    >
      {title}
      {column.getIsSorted() === "asc" ? (
        <IconChevronUp className="ml-2 h-4 w-4" />
      ) : column.getIsSorted() === "desc" ? (
        <IconChevronDown className="ml-2 h-4 w-4" />
      ) : (
        <IconSelector className="ml-2 h-4 w-4" />
      )}
    </Button>
  ), []);

  const handleEdit = useCallback((role: Role) => {
    setEditingRole(role)
    setShowRoleForm(true)
  }, [])

  const handleDelete = useCallback(async (role: Role) => {
    if (role.isSystem) {
      toast({
        title: "Error",
        description: "Cannot delete system roles",
        variant: "destructive"
      })
      return
    }

    if (!confirm("Are you sure you want to delete this role?")) return

    try {
      const response = await fetch(`/api/admin/roles/${role.id}`, {
        method: 'DELETE',
      })
      
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to delete role')
      }
      
      toast({
        title: "Success",
        description: "Role deleted successfully",
        variant: "default"
      })
      
      // Refresh the page to update the table
      window.location.reload()
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete role",
        variant: "destructive"
      })
    }
  }, [toast])

  const handleManageTools = useCallback((role: Role) => {
    setSelectedRole(role)
    setShowToolAssignments(true)
  }, [])

  const columns = useMemo<ColumnDef<Role>[]>(
    () => [
      {
        accessorKey: 'name',
        header: ({ column }) => <SortableColumnHeader column={column} title="Name" />,
      },
      {
        accessorKey: 'description',
        header: ({ column }) => <SortableColumnHeader column={column} title="Description" />,
      },
      {
        accessorKey: 'isSystem',
        header: ({ column }) => <SortableColumnHeader column={column} title="System Role" />,
        cell: ({ row }) => row.getValue('isSystem') ? "Yes" : "No",
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleEdit(row.original)}
              className="text-blue-500 hover:text-blue-600"
            >
              <IconEdit size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleManageTools(row.original)}
              className="text-green-500 hover:text-green-600"
            >
              <IconTool size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={row.original.isSystem}
              onClick={() => handleDelete(row.original)}
              className="text-destructive hover:text-destructive/90"
            >
              <IconTrash size={16} />
            </Button>
          </div>
        ),
      },
    ],
    [SortableColumnHeader, handleEdit, handleManageTools, handleDelete]
  );

  const table = useReactTable({
    data: roles || [],
    columns,
    state: {
      sorting,
    },
    enableMultiSort: true,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const handleAddRole = useCallback(() => {
    setEditingRole(null)
    setShowRoleForm(true)
  }, [])

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSorting([])}
            className="text-xs"
            disabled={sorting.length === 0}
          >
            Reset Sort
          </Button>
          {sorting.length > 0 && (
            <span className="text-sm text-muted-foreground">
              Hold Shift to sort by multiple columns
            </span>
          )}
        </div>
        <Button onClick={handleAddRole}>
          Add Role
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="bg-muted hover:bg-muted">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="h-10">
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
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row, index) => (
                <TableRow 
                  key={row.id}
                  className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
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
                  No roles found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {showRoleForm && (
        <RoleForm
          role={editingRole}
          onClose={() => {
            setShowRoleForm(false)
            setEditingRole(null)
          }}
        />
      )}

      {showToolAssignments && selectedRole && (
        <div className="space-y-4">
          <ToolAssignments
            role={selectedRole}
            allTools={tools}
            assignedTools={[]}
          />
          <Button 
            onClick={() => {
              setShowToolAssignments(false)
              setSelectedRole(null)
            }}
            variant="outline"
          >
            Close Tool Assignments
          </Button>
        </div>
      )}
    </div>
  )
} 