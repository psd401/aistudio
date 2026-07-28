"use client"

import { useState, useEffect, useRef } from "react"
import type { Dispatch, ReactNode, SetStateAction } from "react"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { useAction } from "@/lib/hooks/use-action"
import { RepositoryItemDetails } from "./repository-item-details"
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
  Eye,
  Video,
} from "lucide-react"
import { format } from "date-fns"
import { useToast } from "@/components/ui/use-toast"

interface RepositoryItemListProps {
  repositoryId: number
  canManage: boolean
  onAddItem?: () => void
}

function ItemType({ type }: { type: string }) {
  const icons: Record<string, ReactNode> = {
    document: <FileText className="h-4 w-4" />,
    image: <ImageIcon className="h-4 w-4" />,
    audio: <Music className="h-4 w-4" />,
    video: <Video className="h-4 w-4" />,
    url: <Link className="h-4 w-4" />,
    text: <Type className="h-4 w-4" />,
  }
  return (
    <div className="flex items-center gap-2">
      {icons[type] ?? null}
      <span className="capitalize">{type}</span>
    </div>
  )
}

function ItemStatusBadge({ status }: { status: string }) {
  const statusContent: Record<
    string,
    {
      icon: ReactNode
      label: string
      variant: "default" | "secondary" | "destructive"
    }
  > = {
    completed: {
      icon: <CheckCircle className="h-3 w-3" />,
      label: "Processed",
      variant: "default",
    },
    embedded: {
      icon: <CheckCircle className="h-3 w-3" />,
      label: "Embedded",
      variant: "default",
    },
    processing: {
      icon: <Clock className="h-3 w-3" />,
      label: "Processing",
      variant: "secondary",
    },
    retrying: {
      icon: <RefreshCw className="h-3 w-3" />,
      label: "Retrying",
      variant: "secondary",
    },
    processing_embeddings: {
      icon: <Clock className="h-3 w-3" />,
      label: "Generating Embeddings",
      variant: "secondary",
    },
    processing_ocr: {
      icon: <Clock className="h-3 w-3" />,
      label: "Processing OCR",
      variant: "secondary",
    },
    failed: {
      icon: <AlertCircle className="h-3 w-3" />,
      label: "Failed",
      variant: "destructive",
    },
    embedding_failed: {
      icon: <AlertCircle className="h-3 w-3" />,
      label: "Embedding Failed",
      variant: "destructive",
    },
  }
  const content = statusContent[status]
  if (!content) {
    return (
      <Badge variant="outline" className="gap-1">
        <Clock className="h-3 w-3" />
        Pending
      </Badge>
    )
  }
  return (
    <Badge variant={content.variant} className="gap-1">
      {content.icon}
      {content.label}
    </Badge>
  )
}

function RepositoryItemActions({
  canManage,
  isRetrying,
  item,
  retryingItemId,
  onDelete,
  onDetail,
  onDownload,
  onRetry,
}: {
  canManage: boolean
  isRetrying: boolean
  item: RepositoryItem
  retryingItemId: number | null
  onDelete: (item: RepositoryItem) => void
  onDetail: (item: RepositoryItem) => void
  onDownload: (item: RepositoryItem) => void
  onRetry: (item: RepositoryItem) => void
}) {
  const downloadable = ["document", "image", "audio", "video"].includes(
    item.type
  )
  return (
    <div className="flex justify-end gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onDetail(item)}
        aria-label={`View details for ${item.name}`}
      >
        <Eye className="h-4 w-4" />
      </Button>
      {downloadable && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDownload(item)}
          aria-label={`Download ${item.name}`}
        >
          <Download className="h-4 w-4" />
        </Button>
      )}
      {canManage && item.canRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onRetry(item)}
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
      {canManage && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(item)}
          aria-label={`Remove ${item.name}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}

function RepositoryItemsTable({
  canManage,
  isRetrying,
  items,
  retryingItemId,
  onDelete,
  onDetail,
  onDownload,
  onRetry,
}: {
  canManage: boolean
  isRetrying: boolean
  items: RepositoryItem[]
  retryingItemId: number | null
  onDelete: (item: RepositoryItem) => void
  onDetail: (item: RepositoryItem) => void
  onDownload: (item: RepositoryItem) => void
  onRetry: (item: RepositoryItem) => void
}) {
  return (
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
        {items.map(item => (
          <TableRow key={item.id}>
            <TableCell>
              <ItemType type={item.type} />
            </TableCell>
            <TableCell>
              <div>
                <div className="font-medium">{item.name}</div>
                {item.type === "url" && (
                  <div className="text-sm text-muted-foreground">
                    {item.source}
                  </div>
                )}
                {canManage && item.processingError && (
                  <div className="text-sm text-destructive mt-1">
                    {item.processingError}
                  </div>
                )}
              </div>
            </TableCell>
            <TableCell>
              <ItemStatusBadge status={item.processingStatus} />
            </TableCell>
            <TableCell>
              {item.createdAt
                ? format(new Date(item.createdAt), "MMM d, yyyy")
                : "-"}
            </TableCell>
            <TableCell className="text-right">
              <RepositoryItemActions
                canManage={canManage}
                isRetrying={isRetrying}
                item={item}
                retryingItemId={retryingItemId}
                onDelete={onDelete}
                onDetail={onDetail}
                onDownload={onDownload}
                onRetry={onRetry}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function RepositoryItemDialogs({
  canManage,
  deleteTarget,
  detailTarget,
  isRemoving,
  onCloseDelete,
  onCloseDetail,
  onConfirmDelete,
}: {
  canManage: boolean
  deleteTarget: RepositoryItem | null
  detailTarget: RepositoryItem | null
  isRemoving: boolean
  onCloseDelete: () => void
  onCloseDetail: () => void
  onConfirmDelete: () => void
}) {
  return (
    <>
      {canManage && (
        <AlertDialog
          open={deleteTarget !== null}
          onOpenChange={open => !open && onCloseDelete()}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove Item</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to remove &quot;{deleteTarget?.name}&quot;
                from this repository? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={onConfirmDelete}
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
      )}
      <Dialog
        open={detailTarget !== null}
        onOpenChange={open => !open && onCloseDetail()}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Repository item details</DialogTitle>
            <DialogDescription>
              Source versions, processing, derived artifacts, and active
              citation locators.
            </DialogDescription>
          </DialogHeader>
          {detailTarget && <RepositoryItemDetails itemId={detailTarget.id} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function usePendingItemRefresh(
  items: RepositoryItem[],
  setRefreshTrigger: Dispatch<SetStateAction<number>>
) {
  useEffect(() => {
    const pendingStatuses = new Set([
      "pending",
      "processing",
      "retrying",
      "processing_embeddings",
      "processing_ocr",
    ])
    if (!items.some(item => pendingStatuses.has(item.processingStatus))) return

    const interval = setInterval(() => {
      setRefreshTrigger(previous => previous + 1)
    }, 5000)
    return () => clearInterval(interval)
  }, [items, setRefreshTrigger])
}

export function RepositoryItemList({
  repositoryId,
  canManage,
  onAddItem,
}: RepositoryItemListProps) {
  const { toast } = useToast()
  const [items, setItems] = useState<RepositoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<RepositoryItem | null>(null)
  const [detailTarget, setDetailTarget] = useState<RepositoryItem | null>(null)

  const { execute: executeList } = useAction(listRepositoryItems)
  const executeListRef = useRef(executeList)
  useEffect(() => {
    executeListRef.current = executeList
  }, [executeList])
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
      const result = await executeListRef.current(repositoryId)
      if (result.isSuccess && result.data) {
        setItems(result.data as RepositoryItem[])
      }
      setLoading(false)
    }
    loadItems()
  }, [repositoryId, refreshTrigger])

  usePendingItemRefresh(items, setRefreshTrigger)

  async function handleDelete() {
    if (!canManage || !deleteTarget) return

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
    if (!canManage) return
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
            {canManage && onAddItem ? (
              <Button onClick={onAddItem}>Add Item</Button>
            ) : (
              <Badge variant="outline">Read only</Badge>
            )}
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
              {canManage && onAddItem ? (
                <Button variant="outline" onClick={onAddItem}>
                  Add your first item
                </Button>
              ) : null}
            </div>
          ) : (
            <RepositoryItemsTable
              canManage={canManage}
              isRetrying={isRetrying}
              items={items}
              retryingItemId={retryingItemId}
              onDelete={setDeleteTarget}
              onDetail={setDetailTarget}
              onDownload={handleDownload}
              onRetry={handleRetry}
            />
          )}
        </CardContent>
      </Card>
      <RepositoryItemDialogs
        canManage={canManage}
        deleteTarget={deleteTarget}
        detailTarget={detailTarget}
        isRemoving={isRemoving}
        onCloseDelete={() => setDeleteTarget(null)}
        onCloseDetail={() => setDetailTarget(null)}
        onConfirmDelete={handleDelete}
      />
    </>
  )
}
