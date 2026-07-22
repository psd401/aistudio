"use client"

import { useState, useEffect } from "react"
import {
  type RepositoryItem,
  listRepositoryItems,
  removeRepositoryItem,
  getDocumentDownloadUrl,
  retryRepositoryItemProcessing,
} from "@/actions/repositories/repository-items.actions"
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
  CardDescription,
  CardHeader,
  CardTitle,
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
import { Badge } from "@/components/ui/badge"
import { useAction } from "@/lib/hooks/use-action"
import {
  FileText,
  Image as ImageIcon,
  Link,
  Music,
  RefreshCw,
  Type,
  Trash2,
  Loader2,
  Download,
  ExternalLink,
  AlertCircle,
  CheckCircle,
  Clock,
  Video,
} from "lucide-react"
import { format } from "date-fns"
import { useToast } from "@/components/ui/use-toast"

interface RepositoryItemListProps {
  repositoryId: number
  onAddItem: () => void
}

export function RepositoryItemList({
  repositoryId,
  onAddItem,
}: RepositoryItemListProps) {
  const { toast } = useToast()
  const [items, setItems] = useState<RepositoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<RepositoryItem | null>(null)

  const { execute: executeList } = useAction(listRepositoryItems)
  const { execute: executeRemove, isPending: isRemoving } = useAction(
    removeRepositoryItem
  )
  const { execute: executeRetry, isPending: isRetrying } = useAction(
    retryRepositoryItemProcessing
  )
  const [retryingItemId, setRetryingItemId] = useState<number | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  useEffect(() => {
    async function loadItems() {
      setLoading(true)
      const result = await executeList(repositoryId)
      if (result.isSuccess && result.data) {
        setItems(result.data as RepositoryItem[])
      }
      setLoading(false)
    }
    loadItems()
  }, [repositoryId, refreshTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every 5 seconds if there are pending items
  useEffect(() => {
    const hasPendingItems = items.some(item => 
      item.processingStatus === 'pending' || 
      item.processingStatus === 'processing' ||
      item.processingStatus === 'retrying' ||
      item.processingStatus === 'processing_embeddings' ||
      item.processingStatus === 'processing_ocr'
    )
    
    if (hasPendingItems) {
      const interval = setInterval(() => {
        setRefreshTrigger(prev => prev + 1)
      }, 5000)
      
      return () => clearInterval(interval)
    }
  }, [items])

  async function handleDelete() {
    if (!deleteTarget) return

    const result = await executeRemove(deleteTarget.id)
    if (result.isSuccess) {
      toast({
        title: "Item removed",
        description: "The item has been removed from the repository.",
      })
      setDeleteTarget(null)
      setRefreshTrigger(prev => prev + 1)
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to remove item",
        variant: "destructive",
      })
    }
  }

  async function handleDownload(item: RepositoryItem) {
    if (!["document", "image", "audio", "video"].includes(item.type)) return

    const result = await getDocumentDownloadUrl(item.id)
    if (result.isSuccess && result.data) {
      // Open the download URL in a new window
      window.open(result.data, '_blank')
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to generate download link",
        variant: "destructive",
      })
    }
  }

  async function handleRetry(item: RepositoryItem) {
    setRetryingItemId(item.id)
    const result = await executeRetry(item.id)
    if (result.isSuccess) {
      toast({
        title: "Processing restarted",
        description: `${item.name} has been queued again.`,
      })
      setRefreshTrigger(prev => prev + 1)
    } else {
      toast({
        title: "Retry failed",
        description: result.message || "Failed to restart content processing",
        variant: "destructive",
      })
    }
    setRetryingItemId(null)
  }

  function getItemIcon(type: string) {
    switch (type) {
      case "document":
        return <FileText className="h-4 w-4" />
      case "image":
        return <ImageIcon className="h-4 w-4" />
      case "audio":
        return <Music className="h-4 w-4" />
      case "video":
        return <Video className="h-4 w-4" />
      case "url":
        return <Link className="h-4 w-4" />
      case "text":
        return <Type className="h-4 w-4" />
      default:
        return null
    }
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case "completed":
        return (
          <Badge variant="default" className="gap-1">
            <CheckCircle className="h-3 w-3" />
            Processed
          </Badge>
        )
      case "embedded":
        return (
          <Badge variant="default" className="gap-1">
            <CheckCircle className="h-3 w-3" />
            Embedded
          </Badge>
        )
      case "processing":
        return (
          <Badge variant="secondary" className="gap-1">
            <Clock className="h-3 w-3" />
            Processing
          </Badge>
        )
      case "retrying":
        return (
          <Badge variant="secondary" className="gap-1">
            <RefreshCw className="h-3 w-3" />
            Retrying
          </Badge>
        )
      case "processing_embeddings":
        return (
          <Badge variant="secondary" className="gap-1">
            <Clock className="h-3 w-3" />
            Generating Embeddings
          </Badge>
        )
      case "processing_ocr":
        return (
          <Badge variant="secondary" className="gap-1">
            <Clock className="h-3 w-3" />
            Processing OCR
          </Badge>
        )
      case "failed":
        return (
          <Badge variant="destructive" className="gap-1">
            <AlertCircle className="h-3 w-3" />
            Failed
          </Badge>
        )
      case "embedding_failed":
        return (
          <Badge variant="destructive" className="gap-1">
            <AlertCircle className="h-3 w-3" />
            Embedding Failed
          </Badge>
        )
      default:
        return (
          <Badge variant="outline" className="gap-1">
            <Clock className="h-3 w-3" />
            Pending
          </Badge>
        )
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Repository Items</CardTitle>
              <CardDescription>
                Documents, URLs, and text content in this repository
              </CardDescription>
            </div>
            <Button onClick={onAddItem}>Add Item</Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground mb-4">
                No items in this repository yet
              </p>
              <Button variant="outline" onClick={onAddItem}>
                Add your first item
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {getItemIcon(item.type)}
                        <span className="capitalize">{item.type}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="font-medium">{item.name}</div>
                        {item.type === "url" && (
                          <div className="text-sm text-muted-foreground">
                            {item.source}
                          </div>
                        )}
                        {item.processingError && (
                          <div className="text-sm text-destructive mt-1">
                            {item.processingError}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{getStatusBadge(item.processingStatus)}</TableCell>
                    <TableCell>
                      {item.createdAt ? format(new Date(item.createdAt), "MMM d, yyyy") : "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {["document", "image", "audio", "video"].includes(item.type) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDownload(item)}
                            aria-label={`Download ${item.name}`}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        )}
                        {item.canRetry && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRetry(item)}
                            disabled={isRetrying && retryingItemId === item.id}
                            aria-label={`Retry processing ${item.name}`}
                          >
                            {isRetrying && retryingItemId === item.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                        {item.type === "url" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => window.open(item.source, "_blank")}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(item)}
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
            <AlertDialogTitle>Remove Item</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove &quot;{deleteTarget?.name}&quot; from this
              repository? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isRemoving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemoving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
