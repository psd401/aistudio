"use client"

import { useState } from 'react'
import type { ModerationQueueItem } from '@/actions/admin/moderate-prompt.actions'
import { PromptReviewCard } from './prompt-review-card'
import { Button } from '@/components/ui/button'
import { RefreshCw, CheckCircle2, XCircle } from 'lucide-react'
import { bulkModeratePrompts } from '@/actions/admin/moderate-prompt.actions'
import { useToast } from '@/components/ui/use-toast'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface ModerationQueueProps {
  items: ModerationQueueItem[]
  isLoading: boolean
  onRefresh: () => void
}

type BulkModerationAction = 'approved' | 'rejected'

function BulkActionConfirmation({
  action,
  selectedCount,
  onClose,
  onConfirm,
}: {
  action: BulkModerationAction | null
  selectedCount: number
  onClose: () => void
  onConfirm: (action: BulkModerationAction) => void
}) {
  const isApproval = action === 'approved'
  return (
    <AlertDialog open={action !== null} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Confirm Bulk {isApproval ? 'Approval' : 'Rejection'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to {isApproval ? 'approve' : 'reject'}{' '}
            {selectedCount} prompt{selectedCount > 1 ? 's' : ''}? This action
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => action && onConfirm(action)}
            className={
              action === 'rejected'
                ? 'bg-destructive hover:bg-destructive/90'
                : ''
            }
          >
            {isApproval ? 'Approve' : 'Reject'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function ModerationQueue({ items, isLoading, onRefresh }: ModerationQueueProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isBulkProcessing, setIsBulkProcessing] = useState(false)
  const [bulkAction, setBulkAction] = useState<'approved' | 'rejected' | null>(null)
  const { toast } = useToast()

  const toggleSelection = (id: string) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedIds(newSelected)
  }

  const selectAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(items.map(item => item.id)))
    }
  }

  const handleBulkAction = async (action: 'approved' | 'rejected') => {
    if (selectedIds.size === 0) return

    setIsBulkProcessing(true)
    try {
      const result = await bulkModeratePrompts(
        Array.from(selectedIds),
        { status: action }
      )

      if (result.isSuccess) {
        toast({
          title: 'Success',
          description: result.message,
        })
        setSelectedIds(new Set())
        onRefresh()
      } else {
        toast({
          title: 'Error',
          description: result.message,
          variant: 'destructive'
        })
      }
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to process bulk action',
        variant: 'destructive'
      })
    } finally {
      setIsBulkProcessing(false)
      setBulkAction(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No prompts in this queue</p>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          className="mt-4"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Bulk Actions Bar */}
      <div className="flex items-center justify-between bg-muted p-4 rounded-lg">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={selectAll}
          >
            {selectedIds.size === items.length ? 'Deselect All' : 'Select All'}
          </Button>
          {selectedIds.size > 0 && (
            <span className="text-sm text-muted-foreground">
              {selectedIds.size} selected
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <Button
                variant="default"
                size="sm"
                onClick={() => setBulkAction('approved')}
                disabled={isBulkProcessing}
              >
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Approve Selected
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkAction('rejected')}
                disabled={isBulkProcessing}
              >
                <XCircle className="h-4 w-4 mr-2" />
                Reject Selected
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isLoading}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Queue Items */}
      <div className="space-y-4">
        {items.map((item) => (
          <PromptReviewCard
            key={item.id}
            item={item}
            isSelected={selectedIds.has(item.id)}
            onToggleSelect={toggleSelection}
            onRefresh={onRefresh}
          />
        ))}
      </div>

      <BulkActionConfirmation
        action={bulkAction}
        selectedCount={selectedIds.size}
        onClose={() => setBulkAction(null)}
        onConfirm={handleBulkAction}
      />
    </div>
  )
}
