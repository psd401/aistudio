"use client"

import { useState } from 'react'
import type { ModerationQueueItem } from '@/actions/admin/moderate-prompt.actions'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { CheckCircle2, XCircle, User, Eye, Copy, ChevronDown, ChevronUp } from 'lucide-react'
import { moderatePrompt } from '@/actions/admin/moderate-prompt.actions'
import { useToast } from '@/components/ui/use-toast'
import { format } from 'date-fns'

interface PromptReviewCardProps {
  item: ModerationQueueItem
  isSelected: boolean
  onToggleSelect: (id: string) => void
  onRefresh: () => void
}

export function PromptReviewCard({
  item,
  isSelected,
  onToggleSelect,
  onRefresh
}: PromptReviewCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [notes, setNotes] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const { toast } = useToast()

  const handleModerate = async (status: 'approved' | 'rejected') => {
    setIsProcessing(true)
    try {
      const result = await moderatePrompt(item.id, {
        status,
        notes: notes.trim() || undefined
      })

      if (result.isSuccess) {
        toast({
          title: 'Success',
          description: result.message,
        })
        setNotes('')
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
        description: 'Failed to moderate prompt',
        variant: 'destructive'
      })
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <Card className={isSelected ? 'border-primary' : ''}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 flex-1">
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelect(item.id)}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <CardTitle className="text-lg">{item.title}</CardTitle>
                <Badge variant={
                  item.moderationStatus === 'approved' ? 'default' :
                  item.moderationStatus === 'rejected' ? 'destructive' :
                  'secondary'
                }>
                  {item.moderationStatus}
                </Badge>
                <Badge variant="outline">{item.visibility}</Badge>
              </div>
              <CardDescription className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1">
                  <User className="h-3 w-3" />
                  {item.creatorFirstName} {item.creatorLastName}
                </span>
                <span>•</span>
                <span>{format(new Date(item.createdAt), 'MMM d, yyyy h:mm a')}</span>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <Eye className="h-3 w-3" />
                  {item.viewCount} views
                </span>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <Copy className="h-3 w-3" />
                  {item.useCount} uses
                </span>
              </CardDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Description */}
        {item.description && (
          <div>
            <p className="text-sm text-muted-foreground">{item.description}</p>
          </div>
        )}

        {/* Tags */}
        {item.tags && item.tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {item.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* Expanded Content */}
        {isExpanded && (
          <>
            <div className="border rounded-lg p-4 bg-muted/50">
              <p className="text-sm font-medium mb-2">Prompt Content:</p>
              <pre className="text-sm whitespace-pre-wrap font-mono">{item.content}</pre>
            </div>

            {/* Creator Info */}
            <div className="border rounded-lg p-4 bg-muted/50">
              <p className="text-sm font-medium mb-2">Creator Information:</p>
              <div className="text-sm space-y-1">
                <p><span className="font-medium">Name:</span> {item.creatorFirstName} {item.creatorLastName}</p>
                <p><span className="font-medium">Email:</span> {item.creatorEmail}</p>
              </div>
            </div>

            {/* Moderation Notes */}
            {item.moderationStatus === 'pending' && (
              <div className="space-y-2">
                <label htmlFor={`moderation-notes-${item.id}`} className="text-sm font-medium">
                  Moderation Notes (optional)
                </label>
                <Textarea
                  id={`moderation-notes-${item.id}`}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add any notes about this moderation decision..."
                  rows={3}
                />
              </div>
            )}

            {/* Action Buttons */}
            {item.moderationStatus === 'pending' && (
              <div className="flex gap-2">
                <Button
                  variant="default"
                  onClick={() => handleModerate('approved')}
                  disabled={isProcessing}
                  className="flex-1"
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Approve
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => handleModerate('rejected')}
                  disabled={isProcessing}
                  className="flex-1"
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Reject
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
