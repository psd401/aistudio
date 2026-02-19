'use client'

import { AssistantRuntimeProvider, type AttachmentAdapter, WebSpeechSynthesisAdapter } from '@assistant-ui/react'
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk'
import { type UIMessage } from '@ai-sdk/react'
import { Thread } from '@/components/assistant-ui/thread'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useCallback, useState, Suspense } from 'react'
import { NexusShell } from './_components/layout/nexus-shell'
import { NexusLayout } from './_components/layout/nexus-layout'
import { ErrorBoundary } from './_components/error-boundary'
import { PromptAutoLoader } from './_components/prompt-auto-loader'
import { ConversationInitializer } from './_components/conversation-initializer'
import { useConversationContext, createNexusHistoryAdapter } from '@/lib/nexus/history-adapter'
import { MultiProviderToolUIs } from './_components/tools/multi-provider-tools'
import { ConnectorToolProvider, useConnectorTools } from './_components/tools/connector-tool-context'
import { ConnectorReconnectPrompt, ConnectorToolFallback } from './_components/tools/connector-tool-ui'
import { useModelsWithPersistence } from '@/lib/hooks/use-models'
import { createEnhancedNexusAttachmentAdapter } from '@/lib/nexus/enhanced-attachment-adapters'
import { validateConversationId } from '@/lib/nexus/conversation-navigation'
import type { SelectAiModel } from '@/types'
import { createLogger } from '@/lib/client-logger'
import { toast } from 'sonner'

const log = createLogger({ moduleName: 'nexus-page' })

// Loading spinner component for Suspense fallback
function NexusLoadingSpinner() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto mb-4" />
        <div className="text-lg text-muted-foreground">Loading Nexus...</div>
      </div>
    </div>
  )
}

// Pre-rendered loading spinner to avoid JSX-as-prop lint warning
const NEXUS_LOADING_FALLBACK = <NexusLoadingSpinner />

// Stable ConversationRuntime component using official AI SDK runtime
interface ConversationRuntimeProviderProps {
  children: React.ReactNode
  conversationId: string | null
  selectedModel: SelectAiModel | null
  enabledTools: string[]
  enabledConnectors: string[]
  attachmentAdapter: AttachmentAdapter
  initialMessages?: UIMessage[]
  onConversationIdChange?: (conversationId: string) => void
  onConnectorReconnect?: (failedServerIds: string[]) => void
}

/** UUID format for validating X-Connector-Reconnect header values */
const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const MAX_RECONNECT_IDS = 10

function ConversationRuntimeProvider({
  children,
  conversationId,
  selectedModel,
  enabledTools,
  enabledConnectors,
  attachmentAdapter,
  initialMessages = [],
  onConversationIdChange,
  onConnectorReconnect
}: ConversationRuntimeProviderProps) {
  const historyAdapter = useMemo(
    () => createNexusHistoryAdapter(conversationId),
    [conversationId]
  )

  // Custom fetch to intercept X-Conversation-Id header for conversation continuity
  // and handle content safety blocked errors with user-friendly messages
  const customFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init)

    // Handle model-not-found errors (404)
    // Note: We show a toast but still return the 404 response to let the AI SDK runtime
    // handle cleanup. This provides dual feedback: user-friendly toast + runtime error handling.
    if (response.status === 404) {
      try {
        const clonedResponse = response.clone()
        const errorData = await clonedResponse.json()
        toast.error('Model Unavailable', {
          description: errorData.error || 'The selected model is no longer available. Please choose a different model.',
          duration: 8000
        })
        log.warn('Selected model not found on server')
      } catch {
        log.debug('Could not parse 404 response as JSON, showing generic toast')
        // Show generic toast even if JSON parsing fails
        toast.error('Model Unavailable', {
          description: 'The selected model is no longer available. Please choose a different model.',
          duration: 8000
        })
      }
    }

    // Handle content safety blocked errors (400 with CONTENT_BLOCKED code)
    if (response.status === 400) {
      try {
        // Clone response to read body without consuming it
        const clonedResponse = response.clone()
        const errorData = await clonedResponse.json()
        if (errorData.code === 'CONTENT_BLOCKED') {
          // Show user-friendly toast notification
          toast.error('Content Blocked', {
            description: errorData.error || 'This content is not appropriate for educational use.',
            duration: 6000
          })
          log.warn('Content blocked by safety guardrails', { error: errorData.error })
        }
      } catch {
        // If we can't parse the error, let the default error handling occur
        log.debug('Could not parse error response as JSON')
      }
    }

    // Extract conversation ID from response header (new conversations only)
    const newConversationId = response.headers.get('X-Conversation-Id')
    if (newConversationId && newConversationId !== conversationId) {
      log.debug('Received new conversation ID from server', {
        newConversationId,
        currentConversationId: conversationId
      })
      // Update parent state for URL and component updates
      if (onConversationIdChange) {
        onConversationIdChange(newConversationId)
      }
    }

    // Handle connector reconnect signal (from failed MCP connector auth)
    const reconnectHeader = response.headers.get('X-Connector-Reconnect')
    if (reconnectHeader) {
      // Parse comma-separated server IDs — validate UUID format and cap count
      const failedIds = reconnectHeader
        .split(',')
        .map(id => id.trim())
        .filter(id => UUID_RE.test(id))
        .slice(0, MAX_RECONNECT_IDS)
      if (failedIds.length > 0) {
        log.warn('Connector reconnect signal received', { failedCount: failedIds.length })
        if (onConnectorReconnect) {
          onConnectorReconnect(failedIds)
        }
      }
    }

    return response
  }, [conversationId, onConversationIdChange, onConnectorReconnect])

  // Use official useChatRuntime from @assistant-ui/react-ai-sdk
  // This natively understands AI SDK's streaming format
  // Note: stableConversationId prevents ConversationInitializer remount,
  // which preserves streaming state without needing useMemo here
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({
      api: '/api/nexus/chat',
      fetch: customFetch,
      body: () => selectedModel ? {
        modelId: selectedModel.modelId,
        provider: selectedModel.provider,
        enabledTools,
        enabledConnectors,
        conversationId: conversationId || undefined
      } : {}
    }),
    adapters: {
      attachments: attachmentAdapter,
      history: historyAdapter,
      speech: new WebSpeechSynthesisAdapter(),
    },
    messages: initialMessages
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  )
}

/**
 * Inner wrapper that uses ConnectorToolContext to wire up
 * the reconnect handler between the runtime and the context.
 */
interface NexusRuntimeWrapperProps {
  conversationId: string | null
  selectedModel: SelectAiModel | null
  enabledTools: string[]
  enabledConnectors: string[]
  attachmentAdapter: AttachmentAdapter
  initialMessages: UIMessage[]
  onConversationIdChange: (id: string) => void
  processingAttachments: Set<string>
  models: SelectAiModel[]
  onModelChange: (model: SelectAiModel) => void
  isLoadingModels: boolean
  onToolsChange: (tools: string[]) => void
  onConnectorsChange: (connectors: string[]) => void
}

function NexusRuntimeWrapper({
  conversationId,
  selectedModel,
  enabledTools,
  enabledConnectors,
  attachmentAdapter,
  initialMessages,
  onConversationIdChange,
  processingAttachments,
  models,
  onModelChange,
  isLoadingModels,
  onToolsChange,
  onConnectorsChange,
}: NexusRuntimeWrapperProps) {
  const { addFailedServerIds, failedServerIds } = useConnectorTools()

  const handleConnectorReconnect = useCallback((ids: string[]) => {
    addFailedServerIds(ids)
    toast.warning('Connector connection expired', {
      description: 'Some connector tools are unavailable. Use the Connect menu to reconnect.',
      duration: 8000,
    })
  }, [addFailedServerIds])

  // Handle reconnect action from the inline prompt.
  // NOTE: Do NOT remove the server ID from failedServerIds here — the prompt
  // should remain visible until actual reconnection succeeds. The OAuth popup
  // flow (Task 5/6) will call removeFailedServerId on success.
  const handleReconnectAction = useCallback((_serverId: string) => {
    // Future: This will open the OAuth popup for the server (Task 5/6)
    // and call removeFailedServerId(serverId) on successful reconnection.
    // For now, show guidance toast while keeping the prompt visible.
    toast.info('Reconnect', {
      description: 'Use the Connect menu in the composer to re-authenticate.',
      duration: 5000,
    })
  }, [])

  return (
    <ConversationRuntimeProvider
      conversationId={conversationId}
      selectedModel={selectedModel}
      enabledTools={enabledTools}
      enabledConnectors={enabledConnectors}
      attachmentAdapter={attachmentAdapter}
      initialMessages={initialMessages}
      onConversationIdChange={onConversationIdChange}
      onConnectorReconnect={handleConnectorReconnect}
    >
      {/* Register tool UI components for all providers */}
      <MultiProviderToolUIs />

      {/* Auto-load prompts from Prompt Library */}
      <PromptAutoLoader />

      <div className="flex h-full flex-col">
        {/* Connector reconnect prompt (shown when auth fails) — inside flex column so it
            shares layout with Thread instead of pushing it outside the scroll container */}
        {failedServerIds.length > 0 && (
          <div className="mx-auto w-full max-w-[48rem] px-4 flex-shrink-0">
            <ConnectorReconnectPrompt
              serverIds={failedServerIds}
              onReconnect={handleReconnectAction}
            />
          </div>
        )}

        <Thread
          processingAttachments={processingAttachments}
          conversationId={conversationId}
          models={models}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
          isLoadingModels={isLoadingModels}
          enabledTools={enabledTools}
          onToolsChange={onToolsChange}
          enabledConnectors={enabledConnectors}
          onConnectorsChange={onConnectorsChange}
          toolFallback={ConnectorToolFallback}
        />
      </div>
    </ConversationRuntimeProvider>
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

  // Connector management state (per-conversation)
  const [enabledConnectors, setEnabledConnectors] = useState<string[]>([])

  // Attachment processing state
  const [processingAttachments, setProcessingAttachments] = useState<Set<string>>(new Set())

  // Conversation continuity state - initialize from validated URL parameter
  const [conversationId, setConversationId] = useState<string | null>(validatedConversationId)

  // Stable conversation ID for ConversationInitializer - only set on initial load from URL
  // This prevents remounting when ID is assigned during runtime
  const [stableConversationId] = useState<string | null>(validatedConversationId)

  // Conversation context for history adapter
  const conversationContext = useConversationContext()
  
  // Debug logging for enabled tools
  useEffect(() => {
    log.debug('Enabled tools changed', { enabledTools })
  }, [enabledTools])
  
  // Wrap setSelectedModel to reload page on model change
  const setSelectedModel = useCallback((model: SelectAiModel | null) => {
    originalSetSelectedModel(model);
    // Clear enabled tools and connectors when switching models
    setEnabledTools([]);
    setEnabledConnectors([]);
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

  // Memoized callback for connector changes to prevent unnecessary re-renders
  const onConnectorsChange = useCallback((connectors: string[]) => {
    setEnabledConnectors(connectors);
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
      <ConnectorToolProvider key={conversationId ?? 'new'}>
        <NexusLayout conversationId={conversationId}>
          <NexusShell>
            <div className="relative h-full">
              {selectedModel ? (
                <ConversationInitializer conversationId={stableConversationId}>
                  {(initialMessages) => (
                    <NexusRuntimeWrapper
                      conversationId={conversationId}
                      selectedModel={selectedModel}
                      enabledTools={enabledTools}
                      enabledConnectors={enabledConnectors}
                      attachmentAdapter={attachmentAdapter}
                      initialMessages={initialMessages}
                      onConversationIdChange={handleConversationIdChange}
                      processingAttachments={processingAttachments}
                      models={models}
                      onModelChange={setSelectedModel}
                      isLoadingModels={isLoadingModels}
                      onToolsChange={onToolsChange}
                      onConnectorsChange={onConnectorsChange}
                    />
                  )}
                </ConversationInitializer>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <div className="text-lg text-muted-foreground">Please select a model to start chatting</div>
                  </div>
                </div>
              )}
            </div>
          </NexusShell>
        </NexusLayout>
      </ConnectorToolProvider>
    </ErrorBoundary>
  )
}

// Main component with Suspense boundary for useSearchParams
export default function NexusPage() {
  return (
    <Suspense fallback={NEXUS_LOADING_FALLBACK}>
      <NexusPageContent />
    </Suspense>
  )
}