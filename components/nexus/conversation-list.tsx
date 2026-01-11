'use client'

import { useState, useEffect, useCallback, memo } from 'react'
import { Button } from '@/components/ui/button'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { Trash2Icon, MessageSquareIcon } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { createLogger } from '@/lib/client-logger'
import { useRouter } from 'next/navigation'
import { navigateToConversation } from '@/lib/nexus/conversation-navigation'

const log = createLogger({ moduleName: 'nexus-conversation-list' })

interface ConversationItem {
  id: string
  title: string
  provider: string
  modelUsed: string
  messageCount: number
  lastMessageAt: string
  createdAt: string
  isArchived: boolean
  isPinned: boolean
}

interface ConversationListProps {
  selectedConversationId?: string | null
}

// Helper function moved outside component to reduce function size
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)
  const diffDays = diffHours / 24

  if (diffHours < 1) {
    return 'Just now'
  } else if (diffHours < 24) {
    return `${Math.floor(diffHours)}h ago`
  } else if (diffDays < 7) {
    return `${Math.floor(diffDays)}d ago`
  } else {
    return date.toLocaleDateString()
  }
}

// Extracted component for conversation row to avoid inline functions
interface ConversationItemRowProps {
  conversation: ConversationItem
  isSelected: boolean
  isDeleting: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

const ConversationItemRow = memo(function ConversationItemRow({
  conversation,
  isSelected,
  isDeleting,
  onSelect,
  onDelete,
}: ConversationItemRowProps) {
  const handleClick = useCallback(() => {
    onSelect(conversation.id)
  }, [conversation.id, onSelect])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      onSelect(conversation.id)
    }
  }, [conversation.id, onSelect])

  const handleStopPropagation = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(conversation.id)
  }, [conversation.id, onDelete])

  return (
    <div
      className={`
        flex items-center gap-2 rounded-lg transition-all cursor-pointer
        hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
        ${isSelected ? 'bg-muted' : ''}
      `}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="flex-grow px-3 py-2 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">
              {conversation.title}
            </p>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">
                {conversation.messageCount} message{conversation.messageCount !== 1 ? 's' : ''}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(conversation.lastMessageAt || conversation.createdAt)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Button */}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <TooltipIconButton
            className="text-destructive hover:text-destructive/80 ml-auto mr-1 size-4 p-4"
            variant="ghost"
            tooltip="Delete conversation"
            onClick={handleStopPropagation}
          >
            <Trash2Icon className="h-4 w-4" />
          </TooltipIconButton>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this conversation and all its messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteClick}
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})

export function ConversationList({ selectedConversationId }: ConversationListProps) {
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null)
  const router = useRouter()
  

  // Load conversations from database with comprehensive error handling
  const loadConversations = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      
      log.debug('Loading conversations from API')
      
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout
      
      const response = await fetch('/api/nexus/conversations?limit=500', {
        signal: controller.signal
      })
      
      clearTimeout(timeoutId)
      
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Authentication required. Please sign in again.')
        } else if (response.status === 403) {
          throw new Error('Access denied. You do not have permission to view conversations.')
        } else if (response.status >= 500) {
          throw new Error('Server error. Please try again later.')
        } else {
          throw new Error(`Failed to load conversations: ${response.status}`)
        }
      }
      
      const data = await response.json()
      const { conversations: loadedConversations = [] } = data
      
      // Validate conversation data structure
      const validConversations = loadedConversations.filter((conv: unknown): conv is ConversationItem => {
        return Boolean(conv) && 
               typeof conv === 'object' && 
               conv !== null &&
               'id' in conv && 
               'title' in conv &&
               typeof (conv as Record<string, unknown>).id === 'string' && 
               typeof (conv as Record<string, unknown>).title === 'string'
      })
      
      if (validConversations.length !== loadedConversations.length) {
        log.warn('Some conversations had invalid data structure', { 
          total: loadedConversations.length,
          valid: validConversations.length
        })
      }
      
      setConversations(validConversations)
      log.debug('Conversations loaded', { count: validConversations.length })
      
    } catch (err) {
      let errorMessage = 'Failed to load conversations'
      
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          errorMessage = 'Request timed out. Please check your connection and try again.'
        } else {
          errorMessage = err.message
        }
      }
      
      log.error('Failed to load conversations', { error: errorMessage })
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }, [])

  // Load conversations on component mount
  useEffect(() => {
    loadConversations()
  }, [loadConversations])


  // Handle conversation selection with secure navigation
  const handleConversationSelect = useCallback((conversationId: string) => {
    log.debug('Conversation selected', { conversationId })
    navigateToConversation(conversationId)
  }, [])

  // Handle deleting a conversation using server action with comprehensive error handling
  const handleDeleteConversation = useCallback(async (conversationId: string) => {
    try {
      log.debug('Deleting conversation', { conversationId })
      setDeletingConversationId(conversationId)

      // Validate conversation ID before proceeding
      if (!conversationId || typeof conversationId !== 'string') {
        throw new Error('Invalid conversation ID')
      }

      // Use server action instead of direct API call
      const { archiveConversationAction } = await import('@/actions/nexus/archive-conversation.actions')
      const result = await archiveConversationAction({ conversationId })

      if (!result.isSuccess) {
        const errorMessage = result.error instanceof Error ? result.error.message :
                           typeof result.error === 'string' ? result.error :
                           'Failed to delete conversation'
        throw new Error(errorMessage)
      }

      // Remove from local state
      setConversations(prev => prev.filter(conv => conv.id !== conversationId))

      // If this was the selected conversation, navigate to new conversation
      if (selectedConversationId === conversationId) {
        router.push('/nexus')
      }

      log.debug('Conversation deleted successfully', { conversationId })

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete conversation'
      log.error('Failed to delete conversation', {
        conversationId,
        error: errorMessage
      })

      // Show user-friendly error feedback
      setError(`Delete failed: ${errorMessage}`)

      // Clear error after a delay
      setTimeout(() => {
        setError(null)
      }, 5000)
    } finally {
      setDeletingConversationId(null)
    }
  }, [selectedConversationId, router])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-muted-foreground mb-4">Failed to load conversations</p>
        <Button variant="outline" size="sm" onClick={loadConversations}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-stretch gap-1.5 text-foreground">
      {/* Conversations List */}
      {conversations.length === 0 ? (
        <div className="text-center py-8">
          <MessageSquareIcon className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No conversations yet</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Your conversations will appear here</p>
        </div>
      ) : (
        <>
          {conversations.map((conversation) => (
            <ConversationItemRow
              key={conversation.id}
              conversation={conversation}
              isSelected={selectedConversationId === conversation.id}
              isDeleting={deletingConversationId === conversation.id}
              onSelect={handleConversationSelect}
              onDelete={handleDeleteConversation}
            />
          ))}
        </>
      )}
    </div>
  )
}