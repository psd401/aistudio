"use client"

import { useEffect, useState } from "react"
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

export function RepositoriesAdminClient() {
  const router = useRouter()
  const { toast } = useToast()
  const [repositories, setRepositories] = useState<RepositoryWithOwner[]>([])
  const [deleteRepoId, setDeleteRepoId] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const { execute: executeList } = useAction(listAllRepositories)
  const { execute: executeDelete, isPending: isDeleting } = useAction(adminDeleteRepository)

  useEffect(() => {
    loadRepositories()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadRepositories() {
    setIsLoading(true)
    const result = await executeList({})
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
  }

  async function handleDelete() {
    if (!deleteRepoId) return

    const result = await executeDelete(deleteRepoId)
    if (result.isSuccess) {
      toast({
        title: "Repository deleted",
        description: "The repository has been deleted successfully.",
      })
      setDeleteRepoId(null)
      loadRepositories()
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
                  repositories.map((repo) => (
                    <TableRow key={repo.id}>
                      <TableCell className="font-medium">
                        <div>
                          <div>{repo.name}</div>
                          {repo.description && (
                            <div className="text-sm text-muted-foreground">
                              {repo.description}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{repo.ownerEmail}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={repo.isPublic ? 'default' : 'secondary'}>
                          {repo.isPublic ? 'Public' : 'Private'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Package className="h-4 w-4 text-muted-foreground" />
                          <span>{repo.itemCount || 0}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {new Date(repo.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
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
                              onClick={() => router.push(`/repositories/${repo.id}`)}
                            >
                              <Eye className="mr-2 h-4 w-4" />
                              View
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => router.push(`/repositories/${repo.id}/edit`)}
                            >
                              <Edit className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => router.push(`/repositories/${repo.id}/items`)}
                            >
                              <Package className="mr-2 h-4 w-4" />
                              Manage Items
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setDeleteRepoId(repo.id)}
                              className="text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteRepoId} onOpenChange={() => setDeleteRepoId(null)}>
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
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}