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
} from "@tanstack/react-table"
import type { Table as ReactTable } from "@tanstack/react-table"
import { useUncompiledReactTable } from "@/components/ui/use-uncompiled-react-table"

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

function StatusBadge({ status }: { status: Assistant["status"] }) {
  const content = {
    draft: { icon: FileText, label: "Draft", variant: "secondary" as const },
    pending_approval: {
      icon: Clock,
      label: "Pending",
      variant: "default" as const,
    },
    approved: {
      icon: CheckCircle,
      label: "Approved",
      variant: "default" as const,
    },
    rejected: {
      icon: XCircle,
      label: "Rejected",
      variant: "destructive" as const,
    },
    disabled: {
      icon: AlertCircle,
      label: "Disabled",
      variant: "secondary" as const,
    },
  }[status]
  const Icon = content.icon
  return (
    <Badge
      variant={content.variant}
      className={status === "approved" ? "bg-green-500" : undefined}
    >
      <Icon className="h-3 w-3 mr-1" />
      {content.label}
    </Badge>
  )
}

function SortableColumnHeader({
  column,
  title,
}: {
  column: {
    toggleSorting: (desc?: boolean) => void
    getIsSorted: () => false | "asc" | "desc"
  }
  title: string
}) {
  const direction = column.getIsSorted()
  return (
    <Button
      variant="ghost"
      onClick={() => column.toggleSorting(direction === "asc")}
      className="h-8 px-2 hover:bg-transparent"
    >
      {title}
      {direction === "asc" ? (
        <ChevronUp className="ml-2 h-4 w-4" />
      ) : direction === "desc" ? (
        <ChevronDown className="ml-2 h-4 w-4" />
      ) : (
        <ChevronsUpDown className="ml-2 h-4 w-4" />
      )}
    </Button>
  )
}

function creatorName(assistant: Assistant): string {
  const creator = assistant.creator
  if (!creator) return ""
  const fullName = `${creator.firstName || ""} ${creator.lastName || ""}`.trim()
  return fullName || creator.email || ""
}

function AssistantActions({
  assistant,
  onAccess,
  onDelete,
  onEdit,
  onPreview,
  onStatusChange,
}: {
  assistant: Assistant
  onAccess: (assistant: Assistant) => void
  onDelete: (id: string) => void
  onEdit: (id: string) => void
  onPreview: (id: string) => void
  onStatusChange: (id: string, action: "approve" | "reject") => void
}) {
  return (
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
          <DropdownMenuItem onClick={() => onEdit(assistant.id)}>
            <Edit className="h-4 w-4 mr-2" />
            Edit in Architect
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onPreview(assistant.id)}>
            <FileText className="h-4 w-4 mr-2" />
            Preview Assistant
          </DropdownMenuItem>
          {assistant.status === "pending_approval" && (
            <>
              <DropdownMenuItem
                onClick={() => onStatusChange(assistant.id, "approve")}
                className="text-green-600"
              >
                <CheckCircle className="h-4 w-4 mr-2" />
                Approve
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onStatusChange(assistant.id, "reject")}
                className="text-red-600"
              >
                <XCircle className="h-4 w-4 mr-2" />
                Reject
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onAccess(assistant)}>
            <Lock className="h-4 w-4 mr-2" />
            Manage access
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => onDelete(assistant.id)}
            className="text-red-600"
          >
            <Trash className="h-4 w-4 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function useAssistantColumns({
  assistants,
  selectedAssistants,
  onAccess,
  onDelete,
  onEdit,
  onPreview,
  onSelect,
  onSelectAll,
  onStatusChange,
}: {
  assistants: Assistant[]
  selectedAssistants: Set<string>
  onAccess: (assistant: Assistant) => void
  onDelete: (id: string) => void
  onEdit: (id: string) => void
  onPreview: (id: string) => void
  onSelect: (id: string) => void
  onSelectAll: () => void
  onStatusChange: (id: string, action: "approve" | "reject") => void
}) {
  return useMemo<ColumnDef<Assistant>[]>(
    () => [
      {
        id: "select",
        header: () => (
          <Checkbox
            checked={
              assistants.length > 0 &&
              selectedAssistants.size === assistants.length
            }
            onCheckedChange={onSelectAll}
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={selectedAssistants.has(row.original.id)}
            onCheckedChange={() => onSelect(row.original.id)}
            aria-label="Select row"
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
      {
        accessorKey: "name",
        header: ({ column }) => (
          <SortableColumnHeader column={column} title="Assistant" />
        ),
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
        header: ({ column }) => (
          <SortableColumnHeader column={column} title="Creator" />
        ),
        cell: ({ row }) => {
          const name = creatorName(row.original)
          if (!name) {
            return <span className="text-muted-foreground">Unknown</span>
          }
          return (
            <div>
              <div className="font-medium">{name}</div>
              {row.original.creator?.email !== name && (
                <div className="text-sm text-muted-foreground">
                  {row.original.creator?.email}
                </div>
              )}
            </div>
          )
        },
        sortingFn: (rowA, rowB) =>
          creatorName(rowA.original).localeCompare(creatorName(rowB.original)),
      },
      {
        accessorKey: "status",
        header: ({ column }) => (
          <SortableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <SortableColumnHeader column={column} title="Created" />
        ),
        cell: ({ row }) =>
          new Date(row.original.createdAt).toLocaleDateString(),
      },
      {
        id: "actions",
        header: () => <div className="text-right">Actions</div>,
        cell: ({ row }) => (
          <AssistantActions
            assistant={row.original}
            onAccess={onAccess}
            onDelete={onDelete}
            onEdit={onEdit}
            onPreview={onPreview}
            onStatusChange={onStatusChange}
          />
        ),
      },
    ],
    [
      assistants.length,
      onAccess,
      onDelete,
      onEdit,
      onPreview,
      onSelect,
      onSelectAll,
      onStatusChange,
      selectedAssistants,
    ]
  )
}

function CreateAssistantDialog({
  formData,
  open,
  onCreate,
  onFormChange,
  onOpenChange,
}: {
  formData: { name: string; description: string }
  open: boolean
  onCreate: () => void
  onFormChange: (value: { name: string; description: string }) => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              onChange={event =>
                onFormChange({ ...formData, name: event.target.value })
              }
              placeholder="Assistant name"
            />
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={event =>
                onFormChange({
                  ...formData,
                  description: event.target.value,
                })
              }
              placeholder="Assistant description"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onCreate} disabled={!formData.name}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AssistantsToolbar({
  formData,
  isCreateOpen,
  searchQuery,
  selectedCount,
  sorting,
  onCreate,
  onCreateOpenChange,
  onExport,
  onFormChange,
  onImport,
  onResetSorting,
  onSearchChange,
}: {
  formData: { name: string; description: string }
  isCreateOpen: boolean
  searchQuery: string
  selectedCount: number
  sorting: SortingState
  onCreate: () => void
  onCreateOpenChange: (open: boolean) => void
  onExport: () => void
  onFormChange: (value: { name: string; description: string }) => void
  onImport: () => void
  onResetSorting: () => void
  onSearchChange: (value: string) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search assistants..."
            value={searchQuery}
            onChange={event => onSearchChange(event.target.value)}
            className="pl-9 w-[300px]"
          />
        </div>
        {sorting.length > 0 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onResetSorting}
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
        {selectedCount > 0 && (
          <Button variant="outline" onClick={onExport}>
            <Download className="h-4 w-4 mr-2" />
            Export ({selectedCount})
          </Button>
        )}
        <Button variant="outline" onClick={onImport}>
          <Upload className="h-4 w-4 mr-2" />
          Import
        </Button>
        <CreateAssistantDialog
          formData={formData}
          open={isCreateOpen}
          onCreate={onCreate}
          onFormChange={onFormChange}
          onOpenChange={onCreateOpenChange}
        />
      </div>
    </div>
  )
}

function AssistantsGrid({ table }: { table: ReactTable<Assistant> }) {
  const rows = table.getRowModel().rows
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map(headerGroup => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map(header => (
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
          {rows.length > 0 ? (
            rows.map(row => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map(cell => (
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
              <TableCell colSpan={6} className="text-center py-8">
                <Bot className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-muted-foreground">No assistants found</p>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function AssistantAccessDialog({
  assistant,
  onClose,
}: {
  assistant: { id: string; name: string } | null
  onClose: () => void
}) {
  return (
    <Dialog open={assistant !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage access</DialogTitle>
          <DialogDescription>
            {assistant
              ? `Control who can run "${assistant.name}".`
              : "Control who can run this assistant."}
          </DialogDescription>
        </DialogHeader>
        {assistant && (
          <ResourceGrantsEditor
            resourceType="assistant"
            resourceId={assistant.id}
            resourceLabel={assistant.name}
            onSaved={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function useAssistants(toast: ReturnType<typeof useToast>["toast"]) {
  const [assistants, setAssistants] = useState<Assistant[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
      setError("Failed to fetch assistants")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchAssistants()
  }, [fetchAssistants])

  const createAssistant = async (formData: {
    name: string
    description: string
  }) => {
    try {
      const response = await fetch("/api/admin/assistants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      })
      const data = await response.json()
      if (!data.isSuccess) {
        toast({
          title: "Error",
          description: data.message || "Failed to create assistant",
          variant: "destructive",
        })
        return false
      }
      toast({
        title: "Assistant created",
        description: "The assistant has been created successfully.",
      })
      await fetchAssistants()
      return true
    } catch {
      toast({
        title: "Error",
        description: "Failed to create assistant",
        variant: "destructive",
      })
      return false
    }
  }

  const deleteAssistant = useCallback(
    async (id: string) => {
      if (!confirm("Are you sure you want to delete this assistant?")) return
      try {
        const response = await fetch(`/api/admin/assistants?id=${id}`, {
          method: "DELETE",
        })
        const data = await response.json()
        if (!data.isSuccess) {
          toast({
            title: "Error",
            description: data.message || "Failed to delete assistant",
            variant: "destructive",
          })
          return
        }
        toast({
          title: "Assistant deleted",
          description: "The assistant has been deleted successfully.",
        })
        await fetchAssistants()
      } catch {
        toast({
          title: "Error",
          description: "Failed to delete assistant",
          variant: "destructive",
        })
      }
    },
    [fetchAssistants, toast]
  )

  const changeStatus = useCallback(
    async (id: string, action: "approve" | "reject") => {
      try {
        const response = await fetch("/api/admin/assistants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, action }),
        })
        const data = await response.json()
        if (!data.isSuccess) {
          toast({
            title: "Error",
            description: data.message || `Failed to ${action} assistant`,
            variant: "destructive",
          })
          return
        }
        toast({
          title: `Assistant ${action}d`,
          description: `The assistant has been ${action}d successfully.`,
        })
        await fetchAssistants()
      } catch {
        toast({
          title: "Error",
          description: `Failed to ${action} assistant`,
          variant: "destructive",
        })
      }
    },
    [fetchAssistants, toast]
  )
  return {
    assistants,
    changeStatus,
    createAssistant,
    deleteAssistant,
    error,
    fetchAssistants,
    isLoading,
  }
}

export function AssistantsTable() {
  const router = useRouter()
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
  const assistantData = useAssistants(toast)
  const { assistants } = assistantData

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

  const columns = useAssistantColumns({
    assistants,
    selectedAssistants,
    onAccess: assistant =>
      setAccessAssistant({ id: assistant.id, name: assistant.name }),
    onDelete: id => void assistantData.deleteAssistant(id),
    onEdit: id => router.push(`/utilities/assistant-architect/${id}/edit`),
    onPreview: id =>
      router.push(`/utilities/assistant-architect/${id}/edit/preview`),
    onSelect: handleSelectAssistant,
    onSelectAll: handleSelectAll,
    onStatusChange: (id, action) =>
      void assistantData.changeStatus(id, action),
  })

  const table = useUncompiledReactTable({
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

  if (assistantData.isLoading) {
    return <div>Loading assistants...</div>
  }

  return (
    <div className="space-y-4">
      {assistantData.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{assistantData.error}</AlertDescription>
        </Alert>
      )}
      <AssistantsToolbar
        formData={formData}
        isCreateOpen={isCreateOpen}
        searchQuery={searchQuery}
        selectedCount={selectedAssistants.size}
        sorting={sorting}
        onCreate={() => {
          void assistantData.createAssistant(formData).then(created => {
            if (!created) return
            setIsCreateOpen(false)
            setFormData({ name: "", description: "" })
          })
        }}
        onCreateOpenChange={setIsCreateOpen}
        onExport={() => setIsExportDialogOpen(true)}
        onFormChange={setFormData}
        onImport={() => setIsImportDialogOpen(true)}
        onResetSorting={() => setSorting([])}
        onSearchChange={setSearchQuery}
      />
      <AssistantsGrid table={table} />

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
        onImportComplete={assistantData.fetchAssistants}
      />

      <AssistantAccessDialog
        assistant={accessAssistant}
        onClose={() => setAccessAssistant(null)}
      />
    </div>
  )
}
