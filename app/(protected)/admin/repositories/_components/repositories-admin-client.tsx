"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAction } from "@/lib/hooks/use-action"
import { 
  listAllRepositories, 
  adminDeleteRepository,
  type RepositoryWithOwner 
} from "@/actions/admin/repositories.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { 
  Loader2, 
  MoreHorizontal, 
  Eye, 
  Edit, 
  Trash2,
  Package
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { PageBranding } from "@/components/ui/page-branding"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { MigrationControlPanel } from "./migration-control-panel"

interface RepositoryTableProps {
  repositories: RepositoryWithOwner[]
  onNavigate: (path: string) => void
  onDelete: (repositoryId: number) => void
}

function RepositoryTable({
  repositories,
  onNavigate,
  onDelete,
}: RepositoryTableProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repositories.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No repositories found
                  </TableCell>
                </TableRow>
              ) : (
                repositories.map((repository) => (
                  <TableRow key={repository.id}>
                    <TableCell className="font-medium">
                      <div>
                        <div>{repository.name}</div>
                        {repository.lifecycleStatus === "deleting" ? (
                          <Badge variant="outline" className="mt-1">
                            Deletion pending retry
                          </Badge>
                        ) : null}
                        {repository.description ? (
                          <div className="text-sm text-muted-foreground">
                            {repository.description}
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{repository.ownerEmail}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={repository.isPublic ? "default" : "secondary"}>
                        {repository.isPublic ? "Public" : "Private"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Package className="h-4 w-4 text-muted-foreground" />
                        <span>{repository.itemCount || 0}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {new Date(repository.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <RepositoryActions
                        repository={repository}
                        onNavigate={onNavigate}
                        onDelete={onDelete}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

function RepositoryActions({
  repository,
  onNavigate,
  onDelete,
}: {
  repository: RepositoryWithOwner
  onNavigate: (path: string) => void
  onDelete: (repositoryId: number) => void
}) {
  const isActive = repository.lifecycleStatus === "active"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">Open menu</span>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={!isActive}
          onClick={() => onNavigate(`/repositories/${repository.id}`)}
        >
          <Eye className="mr-2 h-4 w-4" />
          View
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!isActive}
          onClick={() => onNavigate(`/repositories/${repository.id}/edit`)}
        >
          <Edit className="mr-2 h-4 w-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!isActive}
          onClick={() => onNavigate(`/repositories/${repository.id}/items`)}
        >
          <Package className="mr-2 h-4 w-4" />
          Manage Items
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onDelete(repository.id)}
          className="text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {repository.lifecycleStatus === "deleting"
            ? "Retry deletion"
            : "Delete"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface DeleteRepositoryDialogProps {
  repositoryId: number | null
  isDeleting: boolean
  onClose: () => void
  onConfirm: () => void
}

function DeleteRepositoryDialog({
  repositoryId,
  isDeleting,
  onClose,
  onConfirm,
}: DeleteRepositoryDialogProps) {
  return (
    <AlertDialog open={repositoryId !== null} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently delete the repository
            and all its items.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function RepositoriesAdminClient() {
  const router = useRouter()
  const { toast } = useToast()
  const [repositories, setRepositories] = useState<RepositoryWithOwner[]>([])
  const [deleteRepoId, setDeleteRepoId] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const { execute: executeList } = useAction(listAllRepositories)
  const { execute: executeDelete, isPending: isDeleting } = useAction(adminDeleteRepository)

  const applyRepositoryResult = useCallback((
    result: Awaited<ReturnType<typeof listAllRepositories>>
  ) => {
    if (result.isSuccess && result.data) {
      setRepositories(result.data)
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to load repositories",
        variant: "destructive",
      })
    }
    setIsLoading(false)
  }, [toast])

  const loadRepositories = useCallback(async () => {
    applyRepositoryResult(await executeList({}))
  }, [applyRepositoryResult, executeList])

  useEffect(() => {
    let cancelled = false
    void executeList({}).then((result) => {
      if (!cancelled) {
        applyRepositoryResult(result)
      }
    })
    return () => {
      cancelled = true
    }
  }, [applyRepositoryResult, executeList])

  async function handleDelete() {
    if (!deleteRepoId) return

    const result = await executeDelete(deleteRepoId)
    if (result.isSuccess) {
      toast({
        title: "Repository deleted",
        description: "The repository has been deleted successfully.",
      })
      setDeleteRepoId(null)
      setIsLoading(true)
      void loadRepositories()
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to delete repository",
        variant: "destructive",
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  return (
    <>
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">Repository Management</h1>
        <p className="text-sm text-muted-foreground mt-1">
          View and manage all knowledge repositories across the platform
        </p>
      </div>
      <MigrationControlPanel />
      <RepositoryTable
        repositories={repositories}
        onNavigate={router.push}
        onDelete={setDeleteRepoId}
      />
      <DeleteRepositoryDialog
        repositoryId={deleteRepoId}
        isDeleting={isDeleting}
        onClose={() => setDeleteRepoId(null)}
        onConfirm={handleDelete}
      />
    </>
  )
}
