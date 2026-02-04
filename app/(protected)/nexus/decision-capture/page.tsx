'use client'

import { AssistantRuntimeProvider, WebSpeechSynthesisAdapter } from '@assistant-ui/react'
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk'
import { type UIMessage } from '@ai-sdk/react'
import { Thread, type SuggestedAction } from '@/components/assistant-ui/thread'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useCallback, useState, Suspense } from 'react'
import { NexusShell } from '../_components/layout/nexus-shell'
import { NexusLayout } from '../_components/layout/nexus-layout'
import { ErrorBoundary } from '../_components/error-boundary'
import { ConversationInitializer } from '../_components/conversation-initializer'
import { DecisionToolUIs } from './_components/tools/decision-tools-ui'
import { ChartVisualizationUI } from '../_components/tools/chart-visualization-ui'
import { createEnhancedNexusAttachmentAdapter } from '@/lib/nexus/enhanced-attachment-adapters'
import { validateConversationId, navigateToDecisionCaptureConversation, navigateToNewDecisionCapture } from '@/lib/nexus/conversation-navigation'
import { createLogger } from '@/lib/client-logger'

/**
 * Decision Capture Page
 *
 * Upload meeting transcripts and extract decisions into the context graph.
 * Uses a dedicated chat route (/api/nexus/decision-chat) with admin-configured model.
 * Includes conversation history sidebar filtered to decision-capture provider.
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

// Loading spinner for Suspense fallback
function DecisionCaptureLoadingSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto mb-4" />
        <div className="text-lg text-muted-foreground">Loading Decision Capture...</div>
      </div>
    </div>
  )
}

const LOADING_FALLBACK = <DecisionCaptureLoadingSpinner />

// Runtime provider for decision capture conversations
interface DecisionRuntimeProviderProps {
  conversationId: string | null
  initialMessages?: UIMessage[]
  onConversationIdChange?: (conversationId: string) => void
}

function DecisionRuntimeProvider({
  conversationId,
  initialMessages = [],
  onConversationIdChange,
}: DecisionRuntimeProviderProps) {
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

  // Custom fetch to intercept conversation ID header
  const customFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init)

    const newConversationId = response.headers.get('X-Conversation-Id')
    if (newConversationId && newConversationId !== conversationId) {
      if (onConversationIdChange) {
        onConversationIdChange(newConversationId)
      }
    }

    return response
  }, [conversationId, onConversationIdChange])

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
        conversationId: conversationId || undefined,
      }),
    }),
    adapters: {
      attachments: attachmentAdapter,
      speech: new WebSpeechSynthesisAdapter(),
    },
    messages: initialMessages,
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DecisionToolUIs />
      <ChartVisualizationUI />
      <Thread
        processingAttachments={processingAttachments}
        conversationId={conversationId}
        suggestedActions={DECISION_SUGGESTED_ACTIONS}
      />
    </AssistantRuntimeProvider>
  )
}

// Inner content component that uses useSearchParams (requires Suspense)
function DecisionCapturePageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { data: session, status: sessionStatus } = useSession()

  // Get conversation ID from URL parameter with validation
  const urlConversationId = searchParams.get('id')
  const validatedConversationId = useMemo(() => {
    if (validateConversationId(urlConversationId)) {
      return urlConversationId
    }
    if (urlConversationId) {
      log.warn('Invalid conversation ID in URL parameter', { urlConversationId })
    }
    return null
  }, [urlConversationId])

  // Conversation continuity state - initialize from validated URL parameter
  const [conversationId, setConversationId] = useState<string | null>(validatedConversationId)

  // Stable conversation ID for ConversationInitializer - only set on initial load from URL
  // This prevents remounting when ID is assigned during runtime
  const [stableConversationId] = useState<string | null>(validatedConversationId)

  // Conversation ID callback — update URL when server assigns new ID
  const handleConversationIdChange = useCallback((newConversationId: string) => {
    setConversationId(newConversationId)

    // Update URL to reflect the current conversation
    const newUrl = `/nexus/decision-capture?id=${newConversationId}`
    router.push(newUrl, { scroll: false })

    log.debug('Conversation ID updated', {
      previousId: conversationId,
      newId: newConversationId,
      newUrl,
    })
  }, [conversationId, router])

  // Handle conversation selection from sidebar
  // navigateToDecisionCaptureConversation uses window.location.href (not a React dependency)
  const handleConversationSelect = useCallback((id: string) => {
    navigateToDecisionCaptureConversation(id)
  }, [])

  // Handle new conversation from sidebar
  // navigateToNewDecisionCapture uses window.location.href (not a React dependency)
  const handleNewConversation = useCallback(() => {
    navigateToNewDecisionCapture()
  }, [])

  // Handle invalid conversation ID in URL - redirect to clean state
  useEffect(() => {
    if (urlConversationId && !validatedConversationId) {
      log.warn('Redirecting due to invalid conversation ID in URL', { urlConversationId })
      router.replace('/nexus/decision-capture')
    }
  }, [urlConversationId, validatedConversationId, router])

  // Auth check
  useEffect(() => {
    if (sessionStatus === 'loading') return
    if (sessionStatus === 'unauthenticated' || !session?.user) {
      router.push('/api/auth/signin?callbackUrl=/nexus/decision-capture')
    }
  }, [session, sessionStatus, router])

  if (sessionStatus === 'loading') {
    return <DecisionCaptureLoadingSpinner />
  }

  if (sessionStatus === 'unauthenticated' || !session?.user) {
    return null
  }

  return (
    <ErrorBoundary>
      <NexusLayout
        conversationId={conversationId}
        provider="decision-capture"
        onConversationSelect={handleConversationSelect}
        onNewConversation={handleNewConversation}
      >
        <NexusShell
          title="Decision Capture"
          onNewConversation={handleNewConversation}
        >
          <ConversationInitializer conversationId={stableConversationId}>
            {(initialMessages) => (
              <DecisionRuntimeProvider
                conversationId={conversationId}
                initialMessages={initialMessages}
                onConversationIdChange={handleConversationIdChange}
              />
            )}
          </ConversationInitializer>
        </NexusShell>
      </NexusLayout>
    </ErrorBoundary>
  )
}

// Main component with Suspense boundary for useSearchParams
export default function DecisionCapturePage() {
  return (
    <Suspense fallback={LOADING_FALLBACK}>
      <DecisionCapturePageContent />
    </Suspense>
  )
}
