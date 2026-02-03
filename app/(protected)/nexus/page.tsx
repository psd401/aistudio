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
import { useConversationContext, createNexusHistoryAdapter } from '@/lib/nexus/history-adapter'
import { MultiProviderToolUIs } from './_components/tools/multi-provider-tools'
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

// UIMessage part types for AI SDK v5
// Static tool format: type is 'tool-{toolName}' (e.g., 'tool-show_chart')
// AISDKMessageConverter extracts toolName via type.replace("tool-", "")
type TextPart = { type: 'text'; text: string }
type StaticToolPart = {
  type: string;  // 'tool-{toolName}' format
  toolCallId: string;
  state: 'output-available' | 'output-error' | 'input-available';
  input: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
}
type UIMessagePart = TextPart | StaticToolPart

// Helper to convert content parts to UIMessage parts format
// Converts tool-call to static tool format (type: 'tool-{toolName}')
function convertContentToParts(
  content?: Array<{ type: string; text?: string; [key: string]: unknown }> | string
): UIMessagePart[] {
  if (Array.isArray(content)) {
    const parts: UIMessagePart[] = []

    for (const part of content) {
      // Convert tool-call to static tool format for AISDKMessageConverter
      // type: 'tool-{toolName}' -> converter extracts toolName via type.replace("tool-", "")
      if (part.type === 'tool-call' && part.toolName && part.toolCallId) {
        const toolName = part.toolName as string
        const args = (part.args as Record<string, unknown>) || {}
        const hasResult = part.result !== undefined
        const isError = part.isError === true

        const toolPart: StaticToolPart = {
          type: `tool-${toolName}`,  // e.g., 'tool-show_chart'
          toolCallId: part.toolCallId as string,
          state: isError ? 'output-error' : hasResult ? 'output-available' : 'input-available',
          input: args,
        }

        if (hasResult && !isError) {
          toolPart.output = part.result
        }
        if (isError) {
          toolPart.errorText = typeof part.result === 'string' ? part.result : JSON.stringify(part.result)
        }

        parts.push(toolPart)
      } else {
        // Convert text parts
        parts.push({
          type: 'text',
          text: part.text || ''
        })
      }
    }

    return parts
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return [{ type: 'text', text: '' }]
}

// Stable ConversationRuntime component using official AI SDK runtime
interface ConversationRuntimeProviderProps {
  children: React.ReactNode
  conversationId: string | null
  selectedModel: SelectAiModel | null
  enabledTools: string[]
  attachmentAdapter: AttachmentAdapter
  initialMessages?: UIMessage[]
  onConversationIdChange?: (conversationId: string) => void
}

function ConversationRuntimeProvider({
  children,
  conversationId,
  selectedModel,
  enabledTools,
  attachmentAdapter,
  initialMessages = [],
  onConversationIdChange
}: ConversationRuntimeProviderProps) {
  const historyAdapter = useMemo(
    () => createNexusHistoryAdapter(conversationId),
    [conversationId]
  )

  // Use ref to prevent stale closure on enabledTools
  const enabledToolsRef = useRef(enabledTools)
  useEffect(() => {
    enabledToolsRef.current = enabledTools
  }, [enabledTools])

  // Use ref for conversation ID to ensure synchronous updates
  // This prevents race conditions when sending multiple messages quickly
  const conversationIdRef = useRef(conversationId)
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  // Custom fetch to intercept X-Conversation-Id header for conversation continuity
  // and handle content safety blocked errors with user-friendly messages
  const customFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init)

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
    if (newConversationId && newConversationId !== conversationIdRef.current) {
      log.debug('Received new conversation ID from server', {
        newConversationId,
        currentConversationId: conversationIdRef.current
      })
      // Update ref immediately for synchronous access in next message
      conversationIdRef.current = newConversationId
      // Update parent state for URL and component updates
      if (onConversationIdChange) {
        onConversationIdChange(newConversationId)
      }
    }

    return response
  }, [onConversationIdChange])

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
        enabledTools: enabledToolsRef.current,
        conversationId: conversationIdRef.current || undefined
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

// Component to load conversation messages before creating runtime
function ConversationInitializer({
  conversationId,
  children
}: {
  conversationId: string | null
  children: (messages: UIMessage[]) => React.ReactNode
}) {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      setLoading(false)
      return
    }

    setLoading(true)
    log.debug('ConversationInitializer loading messages', { conversationId })

    fetch(`/api/nexus/conversations/${conversationId}/messages`)
      .then(res => {
        if (!res.ok) {
          throw new Error(`Failed to load messages: ${res.status}`)
        }
        return res.json()
      })
      .then(data => {
        const loadedMessages = data.messages || []
        log.debug('Messages loaded from API', { count: loadedMessages.length })

        // Convert to UIMessage format (required by useChatRuntime)
        const threadMessages = loadedMessages.map((msg: {
          id: string
          role: 'user' | 'assistant' | 'system'
          content?: Array<{ type: string; text?: string; [key: string]: unknown }> | string
          createdAt?: string | Date
        }) => ({
          id: msg.id,
          role: msg.role,
          parts: convertContentToParts(msg.content)
        }))

        setMessages(threadMessages)
        setLoading(false)
        log.debug('Messages converted and ready', { count: threadMessages.length })
      })
      .catch(error => {
        log.error('Failed to load conversation', {
          conversationId,
          error: error instanceof Error ? error.message : String(error)
        })
        setMessages([])
        setLoading(false)
      })
  }, [conversationId])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto mb-4" />
          <div className="text-lg text-muted-foreground">Loading conversation...</div>
        </div>
      </div>
    )
  }

  return <>{children(messages)}</>
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
      <NexusLayout conversationId={conversationId}>
        <NexusShell>
          <div className="relative h-full">
            {selectedModel ? (
              <ConversationInitializer conversationId={stableConversationId}>
                {(initialMessages) => (
                  <ConversationRuntimeProvider
                    conversationId={conversationId}
                    selectedModel={selectedModel}
                    enabledTools={enabledTools}
                    attachmentAdapter={attachmentAdapter}
                    initialMessages={initialMessages}
                    onConversationIdChange={handleConversationIdChange}
                  >
                    {/* Register tool UI components for all providers */}
                    <MultiProviderToolUIs />

                    {/* Auto-load prompts from Prompt Library */}
                    <PromptAutoLoader />

                    <div className="flex h-full flex-col">
                      <Thread
                        processingAttachments={processingAttachments}
                        conversationId={conversationId}
                        models={models}
                        selectedModel={selectedModel}
                        onModelChange={setSelectedModel}
                        isLoadingModels={isLoadingModels}
                        enabledTools={enabledTools}
                        onToolsChange={onToolsChange}
                      />
                    </div>
                  </ConversationRuntimeProvider>
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