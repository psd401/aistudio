"use client"

import { useState, useEffect, useMemo, useCallback } from "react"
import { useRouter } from "next/navigation"
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
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  MoreHorizontal,
  Plus,
  Search,
  Edit,
  Trash,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  Bot,
  FileText,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Download,
  Upload,
  Lock
} from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/components/ui/use-toast"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ExportDialog } from "./export-dialog"
import { ImportDialog } from "./import-dialog"
import { ResourceGrantsEditor } from "@/components/features/resource-grants"
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  SortingState,
  useReactTable,
} from "@tanstack/react-table"

interface Assistant {
  id: string
  name: string
  description?: string
  imagePath?: string
  creatorId: string
  status: "draft" | "pending_approval" | "approved" | "rejected" | "disabled"
  createdAt: string
  updatedAt: string
  creator?: {
    id: string
    firstName: string | null
    lastName: string | null
    email: string | null
  }
}

export function AssistantsTable() {
  const router = useRouter()
  const [assistants, setAssistants] = useState<Assistant[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [formData, setFormData] = useState({
    name: "",
    description: ""
  })
  const [sorting, setSorting] = useState<SortingState>([])
  const [selectedAssistants, setSelectedAssistants] = useState<Set<string>>(new Set())
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false)
  // Per-assistant access editor (#1206) — controlled at the table level so the
  // dialog doesn't unmount with the row's action dropdown.
  const [accessAssistant, setAccessAssistant] = useState<{ id: string; name: string } | null>(null)
  const { toast } = useToast()

  // Fetch assistants
  const fetchAssistants = useCallback(async () => {
    try {
      setError(null)
      const response = await fetch("/api/admin/assistants")
      const data = await response.json()

      if (data.isSuccess) {
        setAssistants(data.data)
      } else {
        setError(data.message || "Failed to fetch assistants")
      }
    } catch {
      // console.error("Error fetching assistants:", error)
      setError("Failed to fetch assistants")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAssistants()
  }, [fetchAssistants])

  // Handle create assistant
  const handleCreate = async () => {
    try {
      const response = await fetch("/api/admin/assistants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      })

      const data = await response.json()

      if (data.isSuccess) {
        toast({
          title: "Assistant created",
          description: "The assistant has been created successfully.",
        })
        setIsCreateOpen(false)
        setFormData({ name: "", description: "" })
        fetchAssistants()
      } else {
        toast({
          title: "Error",
          description: data.message || "Failed to create assistant",
          variant: "destructive",
        })
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to create assistant",
        variant: "destructive",
      })
    }
  }


  // Handle delete assistant
  const handleDelete = useCallback(async (id: string) => {
    if (!confirm("Are you sure you want to delete this assistant?")) return

    try {
      const response = await fetch(`/api/admin/assistants?id=${id}`, {
        method: "DELETE",
      })

      const data = await response.json()

      if (data.isSuccess) {
        toast({
          title: "Assistant deleted",
          description: "The assistant has been deleted successfully.",
        })
        fetchAssistants()
      } else {
        toast({
          title: "Error",
          description: data.message || "Failed to delete assistant",
          variant: "destructive",
        })
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to delete assistant",
        variant: "destructive",
      })
    }
  }, [fetchAssistants, toast])

  // Handle approve/reject
  const handleStatusChange = useCallback(async (id: string, action: "approve" | "reject") => {
    try {
      const response = await fetch("/api/admin/assistants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      })

      const data = await response.json()

      if (data.isSuccess) {
        toast({
          title: `Assistant ${action}d`,
          description: `The assistant has been ${action}d successfully.`,
        })
        fetchAssistants()
      } else {
        toast({
          title: "Error",
          description: data.message || `Failed to ${action} assistant`,
          variant: "destructive",
        })
      }
    } catch {
      toast({
        title: "Error",
        description: `Failed to ${action} assistant`,
        variant: "destructive",
      })
    }
  }, [fetchAssistants, toast])

  // Get status badge
  const getStatusBadge = useCallback((status: Assistant["status"]) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary"><FileText className="h-3 w-3 mr-1" />Draft</Badge>
      case "pending_approval":
        return <Badge variant="default"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
      case "approved":
        return <Badge variant="default" className="bg-green-500"><CheckCircle className="h-3 w-3 mr-1" />Approved</Badge>
      case "rejected":
        return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Rejected</Badge>
      case "disabled":
        return <Badge variant="secondary"><AlertCircle className="h-3 w-3 mr-1" />Disabled</Badge>
    }
  }, [])

  // Handle selection
  const handleSelectAssistant = useCallback((assistantId: string) => {
    const newSelected = new Set(selectedAssistants)
    if (newSelected.has(assistantId)) {
      newSelected.delete(assistantId)
    } else {
      newSelected.add(assistantId)
    }
    setSelectedAssistants(newSelected)
  }, [selectedAssistants])

  const handleSelectAll = useCallback(() => {
    if (selectedAssistants.size === assistants.length) {
      setSelectedAssistants(new Set())
    } else {
      setSelectedAssistants(new Set(assistants.map(a => a.id)))
    }
  }, [selectedAssistants, assistants])

  // Sortable column header component
  const SortableColumnHeader = useCallback(({
    column,
    title,
    className = ""
  }: {
    column: {
      toggleSorting: (desc?: boolean) => void;
      getIsSorted: () => false | "asc" | "desc";
    };
    title: string;
    className?: string;
  }) => (
    <Button
      variant="ghost"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      className={`h-8 px-2 hover:bg-transparent ${className}`}
    >
      {title}
      {column.getIsSorted() === "asc" ? (
        <ChevronUp className="ml-2 h-4 w-4" />
      ) : column.getIsSorted() === "desc" ? (
        <ChevronDown className="ml-2 h-4 w-4" />
      ) : (
        <ChevronsUpDown className="ml-2 h-4 w-4" />
      )}
    </Button>
  ), [])

  // Define columns
  const columns = useMemo<ColumnDef<Assistant>[]>(
    () => [
      {
        id: "select",
        header: () => (
          <Checkbox
            checked={selectedAssistants.size === assistants.length && assistants.length > 0}
            onCheckedChange={handleSelectAll}
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={selectedAssistants.has(row.original.id)}
            onCheckedChange={() => handleSelectAssistant(row.original.id)}
            aria-label="Select row"
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
      {
        accessorKey: "name",
        header: ({ column }) => <SortableColumnHeader column={column} title="Assistant" />,
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.name}</div>
            {row.original.description && (
              <div className="text-sm text-muted-foreground line-clamp-1">
                {row.original.description}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: "creator",
        header: ({ column }) => <SortableColumnHeader column={column} title="Creator" />,
        cell: ({ row }) => {
          const creator = row.original.creator
          if (!creator) return <span className="text-muted-foreground">Unknown</span>
          
          const displayName = creator.firstName && creator.lastName
            ? `${creator.firstName} ${creator.lastName}`
            : creator.email || "Unknown"
          
          return (
            <div>
              <div className="font-medium">{displayName}</div>
              {creator.email && displayName !== creator.email && (
                <div className="text-sm text-muted-foreground">{creator.email}</div>
              )}
            </div>
          )
        },
        sortingFn: (rowA, rowB) => {
          const creatorA = rowA.original.creator
          const creatorB = rowB.original.creator
          
          const nameA = creatorA 
            ? `${creatorA.firstName || ''} ${creatorA.lastName || ''}`.trim() || creatorA.email || ''
            : ''
          const nameB = creatorB
            ? `${creatorB.firstName || ''} ${creatorB.lastName || ''}`.trim() || creatorB.email || ''
            : ''
          
          return nameA.localeCompare(nameB)
        },
      },
      {
        accessorKey: "status",
        header: ({ column }) => <SortableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => getStatusBadge(row.original.status),
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => <SortableColumnHeader column={column} title="Created" />,
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
      },
      {
        id: "actions",
        header: () => <div className="text-right">Actions</div>,
        cell: ({ row }) => (
          <div className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => router.push(`/utilities/assistant-architect/${row.original.id}/edit`)}
                >
                  <Edit className="h-4 w-4 mr-2" />
                  Edit in Architect
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push(`/utilities/assistant-architect/${row.original.id}/edit/preview`)}
                >
                  <FileText className="h-4 w-4 mr-2" />
                  Preview Assistant
                </DropdownMenuItem>
                {row.original.status === "pending_approval" && (
                  <>
                    <DropdownMenuItem
                      onClick={() => handleStatusChange(row.original.id, "approve")}
                      className="text-green-600"
                    >
                      <CheckCircle className="h-4 w-4 mr-2" />
                      Approve
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleStatusChange(row.original.id, "reject")}
                      className="text-red-600"
                    >
                      <XCircle className="h-4 w-4 mr-2" />
                      Reject
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setAccessAssistant({ id: row.original.id, name: row.original.name })}
                >
                  <Lock className="h-4 w-4 mr-2" />
                  Manage access
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => handleDelete(row.original.id)}
                  className="text-red-600"
                >
                  <Trash className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [SortableColumnHeader, getStatusBadge, handleStatusChange, handleDelete, router, selectedAssistants, assistants.length, handleSelectAll, handleSelectAssistant]
  )

  const table = useReactTable({
    data: assistants,
    columns,
    state: {
      sorting,
      globalFilter: searchQuery,
    },
    enableMultiSort: true,
    onSortingChange: setSorting,
    onGlobalFilterChange: setSearchQuery,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  if (isLoading) {
    return <div>Loading assistants...</div>
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search assistants..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-[300px]"
            />
          </div>
          {sorting.length > 0 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSorting([])}
                className="text-xs"
              >
                Reset Sort
              </Button>
              <span className="text-sm text-muted-foreground">
                Hold Shift to sort by multiple columns
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {selectedAssistants.size > 0 && (
            <Button
              variant="outline"
              onClick={() => setIsExportDialogOpen(true)}
            >
              <Download className="h-4 w-4 mr-2" />
              Export ({selectedAssistants.size})
            </Button>
          )}
          
          <Button
            variant="outline"
            onClick={() => setIsImportDialogOpen(true)}
          >
            <Upload className="h-4 w-4 mr-2" />
            Import
          </Button>

          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Assistant
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Assistant</DialogTitle>
              <DialogDescription>
                Add a new AI assistant to the system.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  placeholder="Assistant name"
                />
              </div>
              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({ ...formData, description: e.target.value })
                  }
                  placeholder="Assistant description"
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={!formData.name}>
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <div className="rounded-md border">
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
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8">
                  <Bot className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-muted-foreground">No assistants found</p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <ExportDialog
        open={isExportDialogOpen}
        onOpenChange={setIsExportDialogOpen}
        selectedAssistantIds={Array.from(selectedAssistants)}
        assistants={assistants}
        onExportComplete={() => setSelectedAssistants(new Set())}
      />

      <ImportDialog
        open={isImportDialogOpen}
        onOpenChange={setIsImportDialogOpen}
        onImportComplete={fetchAssistants}
      />

      <Dialog
        open={!!accessAssistant}
        onOpenChange={(open) => { if (!open) setAccessAssistant(null) }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manage access</DialogTitle>
            <DialogDescription>
              {accessAssistant
                ? `Control who can run "${accessAssistant.name}".`
                : "Control who can run this assistant."}
            </DialogDescription>
          </DialogHeader>
          {accessAssistant ? (
            <ResourceGrantsEditor
              resourceType="assistant"
              resourceId={accessAssistant.id}
              resourceLabel={accessAssistant.name}
              onSaved={() => setAccessAssistant(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}