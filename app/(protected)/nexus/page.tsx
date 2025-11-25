'use client'

import { AssistantRuntimeProvider, useLocalRuntime, type AttachmentAdapter, type ChatModelAdapter, WebSpeechSynthesisAdapter } from '@assistant-ui/react'
import { Thread } from '@/components/assistant-ui/thread'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useCallback, useState, useRef, Suspense } from 'react'
import { NexusShell } from './_components/layout/nexus-shell'
import { ErrorBoundary } from './_components/error-boundary'
import { ConversationPanel } from './_components/conversation-panel'
import { PromptAutoLoader } from './_components/prompt-auto-loader'
import { useConversationContext, createNexusHistoryAdapter } from '@/lib/nexus/history-adapter'
import { createNexusStreamingAdapter } from '@/lib/nexus/nexus-streaming-adapter'
import { MultiProviderToolUIs } from './_components/tools/multi-provider-tools'
import { useModelsWithPersistence } from '@/lib/hooks/use-models'
import { createEnhancedNexusAttachmentAdapter } from '@/lib/nexus/enhanced-attachment-adapters'
import { validateConversationId } from '@/lib/nexus/conversation-navigation'
import type { SelectAiModel } from '@/types'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'nexus-page' })

// Stable ConversationRuntime component using official AI SDK runtime
interface ConversationRuntimeProviderProps {
  children: React.ReactNode
  conversationId: string | null
  streamingAdapter: ChatModelAdapter | null
  fallbackAdapter: ChatModelAdapter
  attachmentAdapter: AttachmentAdapter
}

function ConversationRuntimeProvider({
  children,
  conversationId,
  streamingAdapter,
  fallbackAdapter,
  attachmentAdapter
}: ConversationRuntimeProviderProps) {
  const historyAdapter = useMemo(
    () => createNexusHistoryAdapter(conversationId),
    [conversationId]
  )

  // Use useLocalRuntime with streaming adapter - this AUTOMATICALLY calls historyAdapter.load()
  const runtime = useLocalRuntime(
    streamingAdapter || fallbackAdapter,
    {
      adapters: {
        attachments: attachmentAdapter,
        history: historyAdapter,  // Auto-invoked by useLocalRuntime
        speech: new WebSpeechSynthesisAdapter(),
      }
    }
  )

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  )
}

// Component that uses useSearchParams - must be wrapped in Suspense
function NexusPageContent() {
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
  
  // Load models and manage model selection
  const { 
    models, 
    selectedModel, 
    setSelectedModel: originalSetSelectedModel, 
    isLoading: isLoadingModels 
  } = useModelsWithPersistence('nexus-model', ['chat'])
  
  // Tool management state
  const [enabledTools, setEnabledTools] = useState<string[]>([])

  // Attachment processing state
  const [processingAttachments, setProcessingAttachments] = useState<Set<string>>(new Set())

  // Conversation continuity state - initialize from validated URL parameter
  const [conversationId, setConversationId] = useState<string | null>(validatedConversationId)


  // Conversation context for history adapter
  const conversationContext = useConversationContext()
  
  // Debug logging for enabled tools
  useEffect(() => {
    log.debug('Enabled tools changed', { enabledTools })
  }, [enabledTools])
  
  // Wrap setSelectedModel to reload page on model change
  const setSelectedModel = useCallback((model: SelectAiModel | null) => {
    originalSetSelectedModel(model);
    // Clear enabled tools when switching models
    setEnabledTools([]);
    // Clear conversation ID when switching models for fresh conversation
    setConversationId(null);
    // Force page reload to ensure clean state
    if (model && selectedModel && model.modelId !== selectedModel.modelId) {
      window.location.reload();
    }
  }, [originalSetSelectedModel, selectedModel])

  // Memoized callback for tool changes to prevent unnecessary re-renders
  const onToolsChange = useCallback((tools: string[]) => {
    setEnabledTools(tools);
  }, [])

  // Attachment processing callbacks
  const handleAttachmentProcessingStart = useCallback((attachmentId: string) => {
    setProcessingAttachments(prev => new Set([...prev, attachmentId]))
    log.debug('Attachment processing started', { attachmentId })
  }, [])

  const handleAttachmentProcessingComplete = useCallback((attachmentId: string) => {
    setProcessingAttachments(prev => {
      const next = new Set(prev)
      next.delete(attachmentId)
      return next
    })
    log.debug('Attachment processing completed', { attachmentId })
  }, [])

  // Conversation ID callback for maintaining conversation continuity
  const handleConversationIdChange = useCallback((newConversationId: string) => {
    setConversationId(newConversationId)
    conversationContext.setConversationId(newConversationId)

    // Update URL to reflect the current conversation
    const newUrl = `/nexus?id=${newConversationId}`
    router.push(newUrl, { scroll: false })

    log.debug('Conversation ID updated', {
      previousId: conversationId,
      newId: newConversationId,
      newUrl
    })
  }, [conversationId, conversationContext, router])
  
  // Handle invalid conversation ID in URL - redirect to clean state
  useEffect(() => {
    if (urlConversationId && !validatedConversationId) {
      // URL had conversation ID but it was invalid - redirect to clean nexus
      log.warn('Redirecting due to invalid conversation ID in URL', { urlConversationId })
      router.replace('/nexus')
      return
    }
  }, [urlConversationId, validatedConversationId, router])

  // Authentication verification for defense in depth
  useEffect(() => {
    if (sessionStatus === 'loading') return // Still loading, wait
    
    if (sessionStatus === 'unauthenticated' || !session?.user) {
      // Not authenticated, redirect to sign in
      router.push('/api/auth/signin?callbackUrl=/nexus')
      return
    }
  }, [session, sessionStatus, router])

  // Use ref for conversation ID in adapter
  const conversationIdRef = useRef(conversationId)
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  // Use ref for enabled tools
  const enabledToolsRef = useRef(enabledTools)
  useEffect(() => {
    enabledToolsRef.current = enabledTools
  }, [enabledTools])

  // Create streaming adapter
  const streamingAdapter = useMemo(() => {
    if (!selectedModel) return null

    return createNexusStreamingAdapter({
      apiUrl: '/api/nexus/chat',
      bodyFn: () => ({
        modelId: selectedModel.modelId,
        provider: selectedModel.provider,
        enabledTools: enabledToolsRef.current
      }),
      conversationId: conversationIdRef.current || undefined,
      onConversationIdChange: handleConversationIdChange
    })
  }, [selectedModel, handleConversationIdChange])

  // Fallback adapter for when no model is selected
  const fallbackAdapter = useMemo(() => ({
    async run() {
      return {
        content: [{
          type: 'text' as const,
          text: 'Please select a model to start chatting.'
        }]
      }
    }
  }), [])

  // Create attachment adapter with processing callbacks
  const attachmentAdapter = useMemo(() => {
    return createEnhancedNexusAttachmentAdapter({
      onProcessingStart: handleAttachmentProcessingStart,
      onProcessingComplete: handleAttachmentProcessingComplete,
    })
  }, [handleAttachmentProcessingStart, handleAttachmentProcessingComplete])


  // Show loading state while checking authentication
  if (sessionStatus === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto mb-4" />
          <div className="text-lg text-muted-foreground">Loading Nexus...</div>
        </div>
      </div>
    )
  }

  // Don't render if not authenticated (will redirect)
  if (sessionStatus === 'unauthenticated' || !session?.user) {
    return null
  }

  return (
    <ErrorBoundary>
      <NexusShell
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        models={models}
        isLoadingModels={isLoadingModels}
        enabledTools={enabledTools}
        onToolsChange={onToolsChange}
      >
        <div className="relative h-full">
          {selectedModel ? (
            <ConversationRuntimeProvider
              conversationId={conversationId}
              streamingAdapter={streamingAdapter}
              fallbackAdapter={fallbackAdapter}
              attachmentAdapter={attachmentAdapter}
            >
              {/* Register tool UI components for all providers */}
              <MultiProviderToolUIs />

              {/* Auto-load prompts from Prompt Library */}
              <PromptAutoLoader />

              <div className="flex h-full flex-col">
                <Thread processingAttachments={processingAttachments} conversationId={conversationId} />
              </div>
              <ConversationPanel
                selectedConversationId={conversationId}
              />
            </ConversationRuntimeProvider>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="text-lg text-muted-foreground">Please select a model to start chatting</div>
              </div>
            </div>
          )}
        </div>
      </NexusShell>
    </ErrorBoundary>
  )
}

// Main component with Suspense boundary for useSearchParams
export default function NexusPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto mb-4" />
          <div className="text-lg text-muted-foreground">Loading Nexus...</div>
        </div>
      </div>
    }>
      <NexusPageContent />
    </Suspense>
  )
}