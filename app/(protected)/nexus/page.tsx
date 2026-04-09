'use client'

import { AssistantRuntimeProvider, type AttachmentAdapter, WebSpeechSynthesisAdapter } from '@assistant-ui/react'
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk'
import { type UIMessage } from '@ai-sdk/react'
import { Thread } from '@/components/assistant-ui/thread'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useCallback, useState, useRef, Suspense } from 'react'
import { NexusShell } from './_components/layout/nexus-shell'
import { NexusLayout } from './_components/layout/nexus-layout'
import { ErrorBoundary } from './_components/error-boundary'
import { PromptAutoLoader } from './_components/prompt-auto-loader'
import { ConversationInitializer } from './_components/conversation-initializer'
import { z } from 'zod'
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
import { handleContentBlockedResponse } from '@/lib/nexus/content-blocked-handler'
import { getPromptSettings } from '@/actions/prompt-library.actions'
import { ModelFallbackBanner } from './_components/model-fallback-banner'

const log = createLogger({ moduleName: 'nexus-page' })
const uuidSchema = z.string().uuid()
const toolNameSchema = z.string().max(100).regex(/^[\w:-]+$/)

/** Zod schema for X-Connector-Tools response header — validates server-sent tool mapping */
const ConnectorToolsSchema = z.record(z.string(), z.object({
  serverId: z.string().uuid(),
  serverName: z.string(),
}))

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
  onConnectorToolsReceived?: (mapping: Record<string, { serverId: string; serverName: string }>) => void
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
  onConnectorReconnect,
  onConnectorToolsReceived
}: ConversationRuntimeProviderProps) {
  // Use a ref so the adapter instance stays stable when conversationId transitions
  // from null → UUID during a new conversation. Without this, the runtime re-calls
  // load() on the recreated adapter and fetches already-displayed messages,
  // causing duplicate message rendering. (Issue #868)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId

  const historyAdapter = useMemo(
    () => createNexusHistoryAdapter(() => conversationIdRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally stable; conversationId accessed via ref
    []
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

    // Issue #860: Handle CONTENT_BLOCKED 400 responses — shows toast and throws
    // to prevent AI SDK runtime from parsing non-streaming JSON as a stream
    await handleContentBlockedResponse(response, log)

    // Extract conversation ID from response header (new conversations only)
    const newConversationId = response.headers.get('X-Conversation-Id')
    if (newConversationId && newConversationId !== conversationId) {
      if (!uuidSchema.safeParse(newConversationId).success) {
        log.warn('Received malformed X-Conversation-Id header, ignoring', { newConversationId })
      } else {
        log.debug('Received new conversation ID from server', {
          newConversationId,
          currentConversationId: conversationId
        })
        // Update parent state for URL and component updates
        if (onConversationIdChange) {
          onConversationIdChange(newConversationId)
        }
      }
    }

    // Parse connector tool mapping for branded UI rendering (Bug #2 fix)
    const connectorToolsHeader = response.headers.get('X-Connector-Tools')
    if (connectorToolsHeader && onConnectorToolsReceived) {
      try {
        const mapping = ConnectorToolsSchema.parse(JSON.parse(decodeURIComponent(connectorToolsHeader)))
        onConnectorToolsReceived(mapping)
      } catch {
        log.warn('Failed to parse X-Connector-Tools header')
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
  }, [conversationId, onConversationIdChange, onConnectorReconnect, onConnectorToolsReceived])

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
  const { addFailedServerIds, failedServerIds, registerConnectorTools, removeFailedServerId, reset: resetConnectorTools } = useConnectorTools()

  // Reset connector tool state when conversation ID is cleared (user navigated away).
  // This replaces the old key={conversationId} pattern which destroyed the entire React tree
  // mid-stream whenever conversationId changed (null → UUID on first message).
  // We only reset on null (conversation cleared), NOT on null → UUID (first assignment).
  useEffect(() => {
    if (conversationId === null) {
      resetConnectorTools()
    }
  }, [conversationId, resetConnectorTools])

  const handleConnectorReconnect = useCallback((ids: string[]) => {
    addFailedServerIds(ids)
    toast.warning('Connector connection expired', {
      description: 'Some connector tools are unavailable. Use the Connect menu to reconnect.',
      duration: 8000,
    })
  }, [addFailedServerIds])

  const handleConnectorToolsReceived = useCallback((
    mapping: Record<string, { serverId: string; serverName: string }>
  ) => {
    // Group tools by server for batch registration
    const byServer = new Map<string, { info: { serverId: string; serverName: string }; tools: string[] }>()
    for (const [toolName, info] of Object.entries(mapping)) {
      const existing = byServer.get(info.serverId)
      if (existing) {
        existing.tools.push(toolName)
      } else {
        byServer.set(info.serverId, { info, tools: [toolName] })
      }
    }
    for (const { info, tools } of byServer.values()) {
      registerConnectorTools(info, tools)
    }
  }, [registerConnectorTools])

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
      onConnectorToolsReceived={handleConnectorToolsReceived}
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
          onReconnectSuccess={removeFailedServerId}
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

  // Parse URL configuration params — validate formats, cap at 50 entries
  const urlModelId = searchParams.get('model')
  const urlTools = useMemo(() => {
    const raw = searchParams.getAll('tool')
    const validated = raw.filter(t => toolNameSchema.safeParse(t).success).slice(0, 50)
    if (raw.length > validated.length) {
      log.warn('URL tool params truncated or filtered', { rawCount: raw.length, validCount: validated.length })
    }
    return validated
  }, [searchParams])
  const urlConnectors = useMemo(() => {
    const raw = searchParams.getAll('connector')
    const validated = raw.filter(c => uuidSchema.safeParse(c).success).slice(0, 50)
    if (raw.length > validated.length) {
      log.warn('URL connector params truncated or filtered', { rawCount: raw.length, validCount: validated.length })
    }
    return validated
  }, [searchParams])

  // Load models and manage model selection
  const [preferredModelId, setPreferredModelId] = useState<string | null>(urlModelId)
  const {
    models,
    selectedModel,
    setSelectedModel: originalSetSelectedModel,
    isLoading: isLoadingModels
  } = useModelsWithPersistence('nexus-model', ['chat'], preferredModelId)

  // Tool management state — single source of truth from urlTools
  const [enabledTools, setEnabledTools] = useState<string[]>(() => urlTools)

  // Connector management state — single source of truth from urlConnectors
  const [enabledConnectors, setEnabledConnectors] = useState<string[]>(() => urlConnectors)

  // Load prompt settings when promptId is present (lower priority than URL params)
  // Uses getPromptSettings to avoid incrementing view count (PromptAutoLoader handles the full view)
  const urlPromptId = searchParams.get('promptId')
  // Tracks which promptId settings were last requested. Used both to prevent
  // re-applying settings (which would override user changes after initial load)
  // and to discard stale responses when the user rapidly switches prompts.
  const promptSettingsRequestedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!urlPromptId || !uuidSchema.safeParse(urlPromptId).success) return
    if (promptSettingsRequestedRef.current === urlPromptId) return
    promptSettingsRequestedRef.current = urlPromptId
    const requestedId = urlPromptId
    getPromptSettings(requestedId).then(result => {
      // Discard stale response if user has already navigated to a different prompt
      if (promptSettingsRequestedRef.current !== requestedId) return
      if (!result.isSuccess || !result.data) return
      const settings = result.data

      // URL params take priority over prompt settings
      if (!urlModelId && settings.modelId) {
        setPreferredModelId(settings.modelId)
      }
      if (urlTools.length === 0 && settings.tools?.length) {
        setEnabledTools(settings.tools)
      }
      if (urlConnectors.length === 0 && settings.connectors?.length) {
        setEnabledConnectors(settings.connectors)
      }
    }).catch(err => {
      log.warn('Failed to load prompt settings', {
        promptId: requestedId,
        error: err instanceof Error ? err.message : String(err)
      })
    })
  }, [urlPromptId, urlModelId, urlTools, urlConnectors])

  // Model fallback for archived conversations — derived from conversationModelId + available models.
  // Setting conversationModelId to null (on dismiss or navigation) hides the banner.
  const [conversationModelId, setConversationModelId] = useState<string | null>(null)
  const modelFallbackInfo = useMemo(() => {
    if (!conversationModelId || models.length === 0) return null
    const modelExists = models.some(m => m.modelId === conversationModelId)
    if (!modelExists) {
      return {
        originalModel: conversationModelId,
        fallbackModel: selectedModel?.name || 'default model'
      }
    }
    return null
  }, [conversationModelId, models, selectedModel?.name])

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
    // Clear conversation ID and fallback state when switching models
    setConversationId(null);
    setConversationModelId(null);
    // Force page reload to ensure clean state
    if (model && selectedModel && model.modelId !== selectedModel.modelId) {
      window.location.reload();
    }
  }, [originalSetSelectedModel, selectedModel])

  // Store the conversation's model ID when received — availability check is derived via useMemo above
  const handleModelUsed = useCallback((modelId: string | null) => {
    setConversationModelId(modelId)
  }, [])

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
    // Clear fallback state — it's only relevant to the previously loaded conversation
    setConversationModelId(null)
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
      <ConnectorToolProvider>
        <NexusLayout conversationId={conversationId}>
          <NexusShell>
            <div className="relative h-full">
              {selectedModel ? (
                <>
                  {modelFallbackInfo && (
                    <div className="px-4 pt-2">
                      <ModelFallbackBanner
                        originalModel={modelFallbackInfo.originalModel}
                        fallbackModel={modelFallbackInfo.fallbackModel}
                        onDismiss={() => setConversationModelId(null)}
                      />
                    </div>
                  )}
                  <ConversationInitializer
                    conversationId={stableConversationId}
                    onModelUsed={handleModelUsed}
                  >
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
                </>
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