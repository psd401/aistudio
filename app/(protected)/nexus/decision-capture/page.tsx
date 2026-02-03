'use client'

import { AssistantRuntimeProvider, WebSpeechSynthesisAdapter } from '@assistant-ui/react'
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk'
import { Thread, type SuggestedAction } from '@/components/assistant-ui/thread'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useCallback, useState, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { PageBranding } from '@/components/ui/page-branding'
import { DecisionToolUIs } from './_components/tools/decision-tools-ui'
import { ChartVisualizationUI } from '../_components/tools/chart-visualization-ui'
import { createEnhancedNexusAttachmentAdapter } from '@/lib/nexus/enhanced-attachment-adapters'
import { createLogger } from '@/lib/client-logger'

/**
 * Decision Capture Page
 *
 * Upload meeting transcripts and extract decisions into the context graph.
 * Uses a dedicated chat route (/api/nexus/decision-chat) with admin-configured model.
 *
 * NOTE: Conversation history sidebar will be added after Epic #697 lands
 * provider-filtered ConversationList support. See follow-up issue.
 *
 * Part of Epic #675 (Context Graph Decision Capture Layer) - Issue #681
 */

const log = createLogger({ moduleName: 'decision-capture-page' })

const DECISION_SUGGESTED_ACTIONS: SuggestedAction[] = [
  {
    title: "Upload a meeting transcript",
    label: "to extract and capture decisions",
    action: "I have a meeting transcript to upload. Please help me extract the decisions from it.",
  },
  {
    title: "Review recent decisions",
    label: "search the context graph for existing entries",
    action: "Search the context graph for recent decisions and show me what's already been captured.",
  },
  {
    title: "Capture a decision manually",
    label: "without a transcript",
    action: "I'd like to manually capture a decision that was made. Help me structure it with the proper context, stakeholders, and rationale.",
  },
  {
    title: "Check decision completeness",
    label: "validate existing entries in the graph",
    action: "Check if there are any incomplete decisions in the context graph that are missing rationale, stakeholders, or evidence.",
  },
]

export default function DecisionCapturePage() {
  const router = useRouter()
  const { data: session, status: sessionStatus } = useSession()

  // Conversation continuity state
  const [conversationId, setConversationId] = useState<string | null>(null)
  const conversationIdRef = useRef<string | null>(null)

  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  // Attachment processing state
  const [processingAttachments, setProcessingAttachments] = useState<Set<string>>(new Set())

  const handleAttachmentProcessingStart = useCallback((attachmentId: string) => {
    setProcessingAttachments(prev => {
      const next = new Set(prev)
      next.add(attachmentId)
      return next
    })
  }, [])

  const handleAttachmentProcessingComplete = useCallback((attachmentId: string) => {
    setProcessingAttachments(prev => {
      const next = new Set(prev)
      next.delete(attachmentId)
      return next
    })
  }, [])

  // Conversation ID callback
  const handleConversationIdChange = useCallback((newConversationId: string) => {
    conversationIdRef.current = newConversationId
    setConversationId(newConversationId)
    log.debug('Conversation ID updated', { newId: newConversationId })
  }, [])

  // Custom fetch to intercept conversation ID header
  const customFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init)

    const newConversationId = response.headers.get('X-Conversation-Id')
    if (newConversationId && newConversationId !== conversationIdRef.current) {
      conversationIdRef.current = newConversationId
      handleConversationIdChange(newConversationId)
    }

    return response
  }, [handleConversationIdChange])

  // Create attachment adapter
  const attachmentAdapter = useMemo(() => {
    return createEnhancedNexusAttachmentAdapter({
      onProcessingStart: handleAttachmentProcessingStart,
      onProcessingComplete: handleAttachmentProcessingComplete,
    })
  }, [handleAttachmentProcessingStart, handleAttachmentProcessingComplete])

  // Chat runtime — no model picker needed, model is admin-configured
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({
      api: '/api/nexus/decision-chat',
      fetch: customFetch,
      body: () => ({
        conversationId: conversationIdRef.current || undefined,
      }),
    }),
    adapters: {
      attachments: attachmentAdapter,
      speech: new WebSpeechSynthesisAdapter(),
    },
  })

  // Auth check
  useEffect(() => {
    if (sessionStatus === 'loading') return
    if (sessionStatus === 'unauthenticated' || !session?.user) {
      router.push('/api/auth/signin?callbackUrl=/nexus/decision-capture')
    }
  }, [session, sessionStatus, router])

  if (sessionStatus === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto mb-4" />
          <div className="text-lg text-muted-foreground">Loading Decision Capture...</div>
        </div>
      </div>
    )
  }

  if (sessionStatus === 'unauthenticated' || !session?.user) {
    return null
  }

  return (
    <div className="flex h-full flex-col p-4 sm:p-6">
      {/* Header */}
      <div className="mb-4">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">Decision Capture</h1>
        <p className="text-sm text-muted-foreground">
          Upload a meeting transcript to extract and capture decisions into the context graph.
        </p>
      </div>

      {/* Main Content */}
      <Card className="flex-1 overflow-hidden flex flex-col">
        <CardContent className="flex-1 overflow-hidden p-0">
          <AssistantRuntimeProvider runtime={runtime}>
            <DecisionToolUIs />
            <ChartVisualizationUI />
            <Thread
              processingAttachments={processingAttachments}
              conversationId={conversationId}
              suggestedActions={DECISION_SUGGESTED_ACTIONS}
            />
          </AssistantRuntimeProvider>
        </CardContent>
      </Card>
    </div>
  )
}
