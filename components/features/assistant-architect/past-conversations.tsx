'use client'

import { useState, useEffect, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ChevronRight, MessageSquareIcon } from 'lucide-react'
import { createLogger } from '@/lib/client-logger'
import { navigateToConversation } from '@/lib/nexus/conversation-navigation'
import type { AssistantArchitectConversationMetadata, NexusConversationMetadata } from '@/lib/db/types/jsonb'
import { getAssistantArchitectConversationsAction } from '@/actions/assistant-architect/get-conversations.actions'

const log = createLogger({ moduleName: 'past-conversations' })

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
  metadata?: NexusConversationMetadata | AssistantArchitectConversationMetadata | null
}

const VALID_EXECUTION_STATUSES = ['running', 'completed', 'failed'] as const
type ExecutionStatus = typeof VALID_EXECUTION_STATUSES[number]

function isValidExecutionStatus(status: unknown): status is ExecutionStatus {
  return typeof status === 'string' && VALID_EXECUTION_STATUSES.includes(status as ExecutionStatus)
}

function isAssistantArchitectMetadata(
  metadata: NexusConversationMetadata | AssistantArchitectConversationMetadata | null | undefined
): metadata is AssistantArchitectConversationMetadata {
  return metadata !== null && metadata !== undefined && 'assistantName' in metadata
}

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

function ExecutionStatusBadge({ status }: { status: ExecutionStatus }) {
  const variantMap: Record<ExecutionStatus, 'warning' | 'success' | 'error'> = {
    running: 'warning',
    completed: 'success',
    failed: 'error',
  }
  return (
    <Badge variant={variantMap[status]} size="sm">
      {status}
    </Badge>
  )
}

interface PastConversationsProps {
  toolId: number
}

export function PastConversations({ toolId }: PastConversationsProps) {
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)

  const loadConversations = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      log.debug('Fetching conversations via server action', { toolId })

      // Use server action for authorization-checked, server-side filtered data
      const result = await getAssistantArchitectConversationsAction(toolId)

      if (!result.isSuccess) {
        throw new Error(result.message || 'Failed to load conversations')
      }

      const conversations = (result.data || []) as ConversationItem[]
      setConversations(conversations)
      setHasLoaded(true)
      log.debug('Past conversations loaded', { toolId, count: conversations.length })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load conversations'
      log.error('Failed to load past conversations', { error: message, toolId })
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [toolId])

  // Lazy-load: only fetch conversations when section is opened
  useEffect(() => {
    if (isOpen && !hasLoaded && !loading) {
      loadConversations()
    }
  }, [isOpen, hasLoaded, loading, loadConversations])

  const handleConversationClick = useCallback((conversationId: string) => {
    navigateToConversation(conversationId)
  }, [])

  const count = conversations.length

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="flex w-full items-center justify-between px-4 py-3">
          <span className="text-sm font-medium">
            Past Conversations{!loading && ` (${count})`}
          </span>
          <ChevronRight
            className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
          />
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="px-4 pb-4">
          {loading && (
            <div className="flex items-center justify-center py-6">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          )}

          {error && (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground mb-2">Failed to load conversations</p>
              <Button variant="outline" size="sm" onClick={loadConversations}>
                Retry
              </Button>
            </div>
          )}

          {!loading && !error && count === 0 && (
            <div className="text-center py-6">
              <MessageSquareIcon className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">No past conversations</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Run this assistant to see conversation history here
              </p>
            </div>
          )}

          {!loading && !error && count > 0 && (
            <div className="flex flex-col gap-1">
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  role="button"
                  tabIndex={0}
                  onClick={() => handleConversationClick(conv.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') handleConversationClick(conv.id)
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{conv.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">
                        {conv.messageCount} message{conv.messageCount !== 1 ? 's' : ''}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatRelativeTime(conv.lastMessageAt || conv.createdAt)}
                      </span>
                      {isAssistantArchitectMetadata(conv.metadata) &&
                        isValidExecutionStatus(conv.metadata.executionStatus) && (
                          <ExecutionStatusBadge status={conv.metadata.executionStatus} />
                        )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
