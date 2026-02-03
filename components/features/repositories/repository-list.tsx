"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { type Repository, listRepositories, deleteRepository } from "@/actions/repositories/repository.actions"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Card,
  CardContent,
} from "@/components/ui/card"
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
import { useAction } from "@/lib/hooks/use-action"
import { Plus, Trash2, FolderOpen, Globe, Lock, Loader2 } from "lucide-react"
import { format } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { PageBranding } from "@/components/ui/page-branding"

export function RepositoryList() {
  const router = useRouter()
  const { toast } = useToast()
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<Repository | null>(null)

  const { execute: executeList } = useAction(listRepositories)
  const { execute: executeDelete, isPending: isDeleting } = useAction(deleteRepository)

  useEffect(() => {
    async function loadRepositories() {
      setLoading(true)
      const result = await executeList(undefined as never)
      if (result.isSuccess && result.data) {
        setRepositories(result.data as Repository[])
      }
      setLoading(false)
    }
    loadRepositories()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDelete() {
    if (!deleteTarget) return

    const result = await executeDelete(deleteTarget.id)
    if (result.isSuccess) {
      toast({
        title: "Repository deleted",
        description: "The repository has been deleted successfully.",
      })
      setDeleteTarget(null)
      // Trigger re-fetch by setting repositories
      executeList(undefined as never).then(result => {
        if (result.isSuccess && result.data) {
          setRepositories(result.data as Repository[])
        }
      })
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to delete repository",
        variant: "destructive",
      })
    }
  }

  return (
    <>
      {/* Page Header */}
      <div className="mb-6">
        <PageBranding />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Knowledge Repositories</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage knowledge bases for AI assistants
            </p>
          </div>
          <Button onClick={() => router.push("/repositories/new")}>
            <Plus className="mr-2 h-4 w-4" />
            New Repository
          </Button>
        </div>
      </div>

      <Card>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : repositories.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground mb-4">
                No repositories created yet
              </p>
              <Button
                variant="outline"
                onClick={() => router.push("/repositories/new")}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create your first repository
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repositories.map((repo) => (
                  <TableRow key={repo.id}>
                    <TableCell className="font-medium">{repo.name}</TableCell>
                    <TableCell>
                      {repo.description || (
                        <span className="text-muted-foreground">
                          No description
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{repo.ownerName || "Unknown"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {repo.itemCount || 0} items
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {repo.isPublic ? (
                        <div className="flex items-center gap-1">
                          <Globe className="h-4 w-4" />
                          <span>Public</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <Lock className="h-4 w-4" />
                          <span>Private</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {repo.createdAt ? format(new Date(repo.createdAt), "MMM d, yyyy") : "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            router.push(`/repositories/${repo.id}`)
                          }
                        >
                          <FolderOpen className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(repo)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Repository</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.name}&quot;? This will
              permanently delete the repository and all its items. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}