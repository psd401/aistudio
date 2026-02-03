"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useState, useEffect, useCallback, memo, useMemo, useRef } from "react"
import { useToast } from "@/components/ui/use-toast"
import { SelectToolInputField } from "@/types/db-types"
import { Loader2, Sparkles, AlertCircle, Settings } from "lucide-react"
import { ErrorBoundary } from "@/components/error-boundary"
import type { AssistantArchitectWithRelations } from "@/types/assistant-architect-types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { collectAndSanitizeEnabledTools, getToolDisplayName } from '@/lib/assistant-architect/tool-utils'
import { ScheduleModal } from "./schedule-modal"
import Image from "next/image"
import DocumentUploadButton from "@/components/ui/document-upload-button"
import { AssistantRuntimeProvider, useThreadRuntime, useLocalRuntime, type ChatModelRunOptions, type ChatModelRunResult } from '@assistant-ui/react'
import { Thread } from '@/components/assistant-ui/thread'
import { createLogger } from '@/lib/client-logger'
import { ExecutionProgress } from './execution-progress'
import {
  parseSSEEvent,
  isTextDeltaEvent,
  isTextStartEvent,
  isTextEndEvent,
  isReasoningStartEvent,
  isReasoningEndEvent,
  isStartStepEvent,
  isStartEvent,
  isFinishStepEvent,
  isToolCallEvent,
  isToolCallDeltaEvent,
  isToolInputStartEvent,
  isToolInputErrorEvent,
  isToolOutputErrorEvent,
  isToolOutputAvailableEvent,
  isErrorEvent,
  isMessageEvent,
  isAssistantMessageEvent,
  isFinishEvent
} from '@/lib/streaming/sse-event-types'
import { createSSEMonitor } from '@/lib/streaming/sse-monitoring'
import { validateSSEEvent } from '@/lib/streaming/sse-event-schemas'
import { processUnknownEvent } from '@/lib/streaming/graceful-degradation'
import { publishSSEMonitorMetrics } from '@/lib/streaming/cloudwatch-metrics'

const log = createLogger({ moduleName: 'assistant-architect-streaming' })

// Define base schema outside component to prevent re-creation on each render
const stringSchema = z.string()

/**
 * Sanitize image path to prevent path traversal attacks
 * @param imagePath - The image path from the database
 * @returns Sanitized path or null if invalid
 */
function sanitizeImagePath(imagePath: string | null): string | null {
  if (!imagePath) return null

  // Remove any path traversal attempts
  const sanitized = imagePath.replace(/\.\./g, '').replace(/\//g, '')

  // Validate format (only allow alphanumeric, dash, underscore, and common image extensions)
  const validPattern = /^[\w-]+\.(png|jpg|jpeg|svg|webp)$/

  if (!validPattern.test(sanitized)) {
    return null
  }

  return sanitized
}

/**
 * Sanitize option labels to prevent XSS attacks
 * @param label - The option label from the database
 * @returns Sanitized label or empty string if invalid
 */
function sanitizeOptionLabel(label: string): string {
  const SAFE_LABEL_REGEX = /^[\s\w(),.-]+$/
  return SAFE_LABEL_REGEX.test(label) ? label.trim() : ''
}

interface AssistantArchitectStreamingProps {
  tool: AssistantArchitectWithRelations
}

// Options interface for creating the adapter
interface AssistantArchitectAdapterOptions {
  toolId: number
  inputsRef: React.MutableRefObject<Record<string, unknown>>
  hasCompletedExecutionRef: React.MutableRefObject<boolean>
  executionIdRef: React.MutableRefObject<number | null>
  conversationIdRef: React.MutableRefObject<string | null>
  executionModelRef: React.MutableRefObject<{ modelId: string; provider: string } | null>
  onExecutionIdChange: (id: number) => void
  onPromptCountChange: (count: number) => void
}

// Factory function to create a stable ChatModelAdapter
function createAssistantArchitectAdapter(options: AssistantArchitectAdapterOptions) {
  const {
    toolId,
    inputsRef,
    hasCompletedExecutionRef,
    executionIdRef,
    conversationIdRef,
    executionModelRef,
    onExecutionIdChange,
    onPromptCountChange
  } = options

  return {
    async *run(options: ChatModelRunOptions): AsyncGenerator<ChatModelRunResult> {
      const { messages, abortSignal } = options

      log.info('🚀 LocalRuntime run() CALLED', {
        messageCount: messages.length,
        hasAbortSignal: !!abortSignal
      })

      try {
        // DYNAMIC ENDPOINT ROUTING based on execution state
        const endpoint = hasCompletedExecutionRef.current
          ? '/api/nexus/chat'
          : '/api/assistant-architect/execute'

        const mode = hasCompletedExecutionRef.current ? 'CONVERSATION' : 'EXECUTION'

        log.info('Assistant Architect stream request', {
          mode,
          messageCount: messages.length
        })

        // Convert messages to proper format
        const processedMessages = Array.from(messages).map(message => {
          const parts = []

          if (Array.isArray(message.content)) {
            for (const contentPart of message.content) {
              if (contentPart.type === 'text') {
                parts.push({ type: 'text', text: contentPart.text })
              } else {
                parts.push(contentPart)
              }
            }
          } else if (typeof message.content === 'string') {
            parts.push({ type: 'text', text: message.content })
          }

          return {
            id: message.id || `msg-${Date.now()}`,
            role: message.role,
            parts: parts.length > 0 ? parts : [{ type: 'text', text: '' }]
          }
        })

        // Build request body based on mode
        let body: unknown
        if (hasCompletedExecutionRef.current) {
          // CONVERSATION MODE: After execution completes
          const modelConfig = executionModelRef.current || {
            modelId: '3',
            provider: 'openai'
          }

          body = {
            messages: processedMessages,
            modelId: modelConfig.modelId,
            provider: modelConfig.provider,
            conversationId: conversationIdRef.current || undefined,
            enabledTools: []
          }
        } else {
          // EXECUTION MODE: Initial assistant execution
          body = {
            toolId,
            inputs: inputsRef.current
          }
        }

        // Make the fetch request
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal: abortSignal
        })

        if (!response.ok) {
          log.error('Stream request failed', { status: response.status, mode })
          throw new Error(`Stream request failed: ${response.status}`)
        }

        // Extract execution metadata from headers
        const executionId = response.headers.get('X-Execution-Id')
        const promptCount = response.headers.get('X-Prompt-Count')
        const newConversationId = response.headers.get('X-Conversation-Id')

        if (executionId) {
          executionIdRef.current = Number(executionId)
          onExecutionIdChange(Number(executionId))
          log.info('Execution started', { executionId, promptCount })
        }

        if (promptCount) {
          onPromptCountChange(Number(promptCount))
        }

        if (newConversationId && newConversationId !== conversationIdRef.current) {
          // Validate UUID format before storing (defense-in-depth)
          const validation = z.string().uuid().safeParse(newConversationId)
          if (!validation.success) {
            log.error('Invalid conversation ID format from server', {
              conversationId: newConversationId,
              mode,
              error: validation.error.message
            })
            return
          }

          log.info('Conversation ID captured', {
            conversationId: newConversationId,
            mode,
            wasNull: conversationIdRef.current === null
          })
          conversationIdRef.current = newConversationId
        }

        // Process and yield the response stream
        if (!response.body) {
          throw new Error('Response body is null')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let accumulatedText = ''

        // Create SSE monitor for this stream
        const monitor = createSSEMonitor({
          executionId: executionIdRef.current || undefined,
          toolId
        })

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (!line.trim() || line.startsWith(':')) continue

              if (line.startsWith('data: ')) {
                const data = line.slice(6)
                if (data === '[DONE]') break

                try {
                  // Parse and validate the SSE event
                  const event = parseSSEEvent(data)

                  // Record the event in the monitor
                  monitor.recordEvent(event.type)

                  // Validate the event structure (catches field mismatches)
                  const validationResult = validateSSEEvent(event)
                  if (!validationResult.success && validationResult.error) {
                    // Log validation errors but continue processing (graceful degradation)
                    log.warn('SSE event validation failed', {
                      type: event.type,
                      error: validationResult.error.message,
                      hint: validationResult.error.hint
                    })

                    // Record field mismatches if detected
                    if (validationResult.error.hint?.includes('Field name mismatch')) {
                      const eventFields = Object.keys(event)
                      monitor.recordFieldMismatch('delta', eventFields, event.type)
                    }
                  }

                  // Handle text deltas from Vercel AI SDK native stream format
                  if (isTextDeltaEvent(event)) {
                    // Validate critical field exists
                    monitor.validateEventFields(event, ['delta'])
                    accumulatedText += event.delta
                    yield {
                      content: [{
                        type: 'text' as const,
                        text: accumulatedText
                      }]
                    }
                    log.debug('✅ YIELDED text-delta', {
                      deltaLength: event.delta.length,
                      totalLength: accumulatedText.length
                    })
                  }
                  // Handle text stream lifecycle events
                  else if (isTextStartEvent(event)) {
                    log.debug('Text stream started', { id: event.id })
                  }
                  else if (isTextEndEvent(event)) {
                    log.debug('Text stream ended', { id: event.id })
                  }
                  // Handle O1/reasoning model events
                  else if (isReasoningStartEvent(event)) {
                    log.debug('Reasoning started', { id: event.id })
                  }
                  else if (isReasoningEndEvent(event)) {
                    log.debug('Reasoning completed', { id: event.id })
                  }
                  // Handle step lifecycle events
                  else if (isStartStepEvent(event) || isStartEvent(event)) {
                    log.debug('Step started')
                  }
                  else if (isFinishStepEvent(event)) {
                    log.debug('Step finished')
                  }
                  // Handle tool calls
                  else if (isToolCallEvent(event) || isToolCallDeltaEvent(event)) {
                    log.debug('Tool call received', {
                      toolName: event.toolName,
                      type: event.type
                    })
                    // Tool calls are handled by the UI components
                  }
                  // Handle tool input events (from web_search_preview, etc.)
                  else if (isToolInputStartEvent(event)) {
                    log.debug('Tool input started', { toolCallId: event.toolCallId, toolName: event.toolName })
                  }
                  else if (isToolInputErrorEvent(event)) {
                    log.debug('Tool input error', { toolCallId: event.toolCallId, toolName: event.toolName })
                  }
                  else if (isToolOutputErrorEvent(event)) {
                    log.debug('Tool output error', { toolCallId: event.toolCallId, errorText: event.errorText })
                  }
                  else if (isToolOutputAvailableEvent(event)) {
                    log.debug('Tool output available', { toolCallId: event.toolCallId })
                  }
                  // Handle errors
                  else if (isErrorEvent(event)) {
                    log.error('Stream error received', {
                      error: event.error
                    })
                    throw new Error(event.error || 'Stream error')
                  }
                  // Handle message or assistant-message events (complete messages)
                  else if (isMessageEvent(event) || isAssistantMessageEvent(event)) {
                    log.info('Received message event', { type: event.type })
                    const text = event.parts?.find(p => p.type === 'text')?.text
                    if (text) {
                      accumulatedText = text
                      yield {
                        content: [{
                          type: 'text' as const,
                          text: accumulatedText
                        }]
                      }
                      log.debug('✅ YIELDED content from message event', {
                        textLength: accumulatedText.length
                      })
                    }
                  }
                  // Handle finish events (stream completion)
                  else if (isFinishEvent(event)) {
                    log.info('Received finish event')
                    const text = event.message?.parts?.find(p => p.type === 'text')?.text
                    if (text) {
                      accumulatedText = text
                      yield {
                        content: [{
                          type: 'text' as const,
                          text: accumulatedText
                        }]
                      }
                      log.debug('✅ YIELDED content from finish event', {
                        textLength: accumulatedText.length
                      })
                    }
                  }
                  // Handle complete assistant messages (direct format - legacy support)
                  else if ('role' in event && event.role === 'assistant' && 'parts' in event) {
                    log.info('Received complete assistant message (legacy format)')
                    const parts = (event as { parts: unknown }).parts
                    if (Array.isArray(parts)) {
                      const text = parts.find((p: { type: string; text?: string }) => p.type === 'text')?.text
                      if (text) {
                        accumulatedText = text
                        yield {
                          content: [{
                            type: 'text' as const,
                            text: accumulatedText
                          }]
                        }
                        log.debug('✅ YIELDED content from assistant message', {
                          textLength: accumulatedText.length
                        })
                      }
                    }
                  }
                  // Graceful degradation for unknown event types
                  else {
                    log.warn('⚠️ UNHANDLED SSE EVENT TYPE', {
                      type: event.type,
                      keys: Object.keys(event),
                      sample: JSON.stringify(event).substring(0, 200)
                    })

                    // Attempt to extract text content from unknown event
                    const unknownContext = {
                      accumulatedText,
                      monitor,
                      verbose: process.env.NODE_ENV === 'development'
                    }

                    if (processUnknownEvent(event as unknown as Record<string, unknown>, unknownContext)) {
                      accumulatedText = unknownContext.accumulatedText
                      yield {
                        content: [{
                          type: 'text' as const,
                          text: accumulatedText
                        }]
                      }
                      log.debug('✅ YIELDED content from unknown event', {
                        type: event.type,
                        textLength: accumulatedText.length
                      })
                    }
                  }
                } catch (parseError) {
                  // Record parse error in monitor
                  monitor.recordParseError(
                    parseError instanceof Error ? parseError : new Error(String(parseError)),
                    data
                  )

                  log.warn('Failed to parse SSE data', {
                    data: data.substring(0, 100),
                    error: parseError instanceof Error ? parseError.message : String(parseError)
                  })
                }
              }
            }
          }

          // Final yield with complete accumulated text
          if (accumulatedText) {
            yield {
              content: [{
                type: 'text' as const,
                text: accumulatedText
              }]
            }
          }

          // Complete monitoring and publish metrics
          const metrics = monitor.complete()

          // Publish metrics to CloudWatch (non-blocking)
          publishSSEMonitorMetrics(metrics, {
            executionId: executionIdRef.current || undefined,
            toolId
          }).catch(err => {
            log.warn('Failed to publish SSE metrics to CloudWatch', {
              error: err instanceof Error ? err.message : String(err)
            })
          })

          log.info('Streaming completed successfully', {
            totalLength: accumulatedText.length,
            mode,
            metrics: {
              totalEvents: metrics.totalEvents,
              unknownTypes: metrics.unknownTypes.length,
              parseErrors: metrics.parseErrors,
              fieldMismatches: metrics.fieldMismatches.length
            }
          })

        } finally {
          try {
            reader.releaseLock()
          } catch (releaseError) {
            log.warn('Failed to release reader lock', {
              error: releaseError instanceof Error ? releaseError.message : String(releaseError)
            })
          }
        }

      } catch (error) {
        // Handle AbortError gracefully - this occurs during React StrictMode unmount/remount
        // or when the user navigates away. We should silently exit without showing an error.
        if (error instanceof Error && error.name === 'AbortError') {
          log.debug('Stream aborted (likely StrictMode or navigation)', {
            mode: hasCompletedExecutionRef.current ? 'CONVERSATION' : 'EXECUTION'
          })
          return // Silently exit - the runtime will restart if needed
        }

        const errorMode = hasCompletedExecutionRef.current ? 'CONVERSATION' : 'EXECUTION'
        log.error('Streaming adapter error', {
          error: error instanceof Error ? {
            message: error.message,
            name: error.name
          } : String(error),
          mode: errorMode
        })

        // Yield error message to user
        yield {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : 'An unknown error occurred'}`
          }]
        }

        throw error
      }
    }
  }
}

// Runtime provider component to handle streaming with single runtime and custom fetch routing
function AssistantArchitectRuntimeProvider({
  children,
  tool,
  inputs,
  onExecutionIdChange,
  onPromptCountChange,
  onExecutionComplete,
  onExecutionError,
  hasCompletedExecution
}: {
  children: React.ReactNode
  tool: AssistantArchitectWithRelations
  inputs: Record<string, unknown>
  onExecutionIdChange: (executionId: number) => void
  onPromptCountChange: (count: number) => void
  onExecutionComplete: () => void
  onExecutionError: (error: string) => void
  hasCompletedExecution: boolean
}) {
  const inputsRef = useRef(inputs)

  useEffect(() => {
    inputsRef.current = inputs
  }, [inputs])

  // Use refs for callbacks to avoid dependency issues
  const onExecutionIdChangeRef = useRef(onExecutionIdChange)
  const onPromptCountChangeRef = useRef(onPromptCountChange)

  useEffect(() => {
    onExecutionIdChangeRef.current = onExecutionIdChange
    onPromptCountChangeRef.current = onPromptCountChange
  }, [onExecutionIdChange, onPromptCountChange])

  // Track whether we're in execution or conversation mode
  const hasCompletedExecutionRef = useRef(hasCompletedExecution)
  const executionIdRef = useRef<number | null>(null)
  const conversationIdRef = useRef<string | null>(null)

  // Store model configuration from first prompt for follow-up conversations
  const executionModelRef = useRef<{ modelId: string; provider: string } | null>(null)

  // Update refs when parent props change and store model config
  useEffect(() => {
    hasCompletedExecutionRef.current = hasCompletedExecution

    // Store model configuration from first prompt when starting execution
    if (!hasCompletedExecution && tool.prompts && tool.prompts.length > 0) {
      const firstPrompt = tool.prompts[0]
      if (firstPrompt?.modelId) {
        // Fetch model details to get provider
        fetch(`/api/models`)
          .then(res => res.json())
          .then(result => {
            const models = result.data || result
            const model = models.find((m: { id: number }) => m.id === firstPrompt.modelId)
            if (model) {
              executionModelRef.current = {
                modelId: model.id.toString(),
                provider: model.provider
              }
            } else {
              // Fallback to GPT-4o if model not found
              executionModelRef.current = {
                modelId: '3',
                provider: 'openai'
              }
              log.warn('Model not found, using default', { modelId: firstPrompt.modelId })
            }
          })
          .catch(err => {
            log.error('Failed to fetch model config', { error: err })
            // Fallback to GPT-4o
            executionModelRef.current = {
              modelId: '3',
              provider: 'openai'
            }
          })
      }
    }
  }, [hasCompletedExecution, tool.prompts])

  // Create stable adapter using useMemo to prevent recreation on every render
  const adapter = useMemo(
    () => createAssistantArchitectAdapter({
      toolId: tool.id,
      inputsRef,
      hasCompletedExecutionRef,
      executionIdRef,
      conversationIdRef,
      executionModelRef,
      onExecutionIdChange: onExecutionIdChangeRef.current,
      onPromptCountChange: onPromptCountChangeRef.current
    }),
    [tool.id] // Only recreate adapter when tool changes
  )

  // Use LocalRuntime with stable adapter reference
  const runtime = useLocalRuntime(adapter)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <StreamingStateMonitor
        onExecutionComplete={onExecutionComplete}
        onExecutionError={onExecutionError}
        hasCompletedExecutionRef={hasCompletedExecutionRef}
      />
      <AutoStartExecution
        tool={tool}
        hasCompletedExecution={hasCompletedExecution}
        hasCompletedExecutionRef={hasCompletedExecutionRef}
        inputs={inputs}
      />
      {children}
    </AssistantRuntimeProvider>
  )
}

// Component to monitor streaming state changes
function StreamingStateMonitor({
  onExecutionComplete,
  onExecutionError,
  hasCompletedExecutionRef
}: {
  onExecutionComplete: () => void
  onExecutionError: (error: string) => void
  hasCompletedExecutionRef: React.MutableRefObject<boolean>
}) {
  const runtime = useThreadRuntime()
  const [previousRunning, setPreviousRunning] = useState<boolean | null>(null)
  const completionFiredRef = useRef(false)

  // Use refs to avoid stale closures
  const onExecutionCompleteRef = useRef(onExecutionComplete)
  const onExecutionErrorRef = useRef(onExecutionError)

  useEffect(() => {
    onExecutionCompleteRef.current = onExecutionComplete
    onExecutionErrorRef.current = onExecutionError
  }, [onExecutionComplete, onExecutionError])

  useEffect(() => {
    // Reset completion flag when previousRunning changes to true
    if (previousRunning === true) {
      completionFiredRef.current = false
    }

    // Subscribe to runtime state changes
    const unsubscribe = runtime.subscribe(() => {
      const threadState = runtime.getState()
      const isRunning = threadState.isRunning

      // Detect completion: was running, now not running
      if (previousRunning === true && !isRunning && !completionFiredRef.current) {
        completionFiredRef.current = true

        // IMPORTANT: Switch to conversation mode BEFORE firing completion
        hasCompletedExecutionRef.current = true

        const messages = threadState.messages
        const lastMessage = messages[messages.length - 1]

        // Check if last message has an error
        if (lastMessage && 'error' in lastMessage && lastMessage.error) {
          const errorMessage = typeof lastMessage.error === 'string'
            ? lastMessage.error
            : 'Execution failed'
          onExecutionErrorRef.current(errorMessage)
        } else {
          onExecutionCompleteRef.current()
        }
      }

      setPreviousRunning(isRunning)
    })

    return unsubscribe
  }, [runtime, previousRunning, hasCompletedExecutionRef])

  return null
}

// Component to automatically start execution when runtime is ready
function AutoStartExecution({
  tool,
  hasCompletedExecution,
  hasCompletedExecutionRef,
  inputs
}: {
  tool: AssistantArchitectWithRelations
  hasCompletedExecution: boolean
  hasCompletedExecutionRef: React.MutableRefObject<boolean>
  inputs: Record<string, unknown>
}) {
  const runtime = useThreadRuntime()
  const hasStarted = useRef(false)

  useEffect(() => {
    // Reset mode when starting fresh execution
    if (!hasCompletedExecution && hasCompletedExecutionRef.current) {
      hasCompletedExecutionRef.current = false
    }

    // Only start once when runtime is ready AND not already completed
    if (!hasStarted.current && !hasCompletedExecution) {
      hasStarted.current = true

      // Use setTimeout(0) to defer execution until after React StrictMode completes
      // its unmount/remount cycle. This prevents the first request from being aborted.
      const timeoutId = setTimeout(() => {
        runtime.append({
          role: 'user',
          content: [{ type: 'text', text: `Execute ${tool.name}` }]
        })
        log.info('Execution started', { toolName: tool.name, inputKeys: Object.keys(inputs) })
      }, 0)

      // Cleanup: clear timeout and reset hasStarted so StrictMode remount can restart
      return () => {
        clearTimeout(timeoutId)
        hasStarted.current = false
      }
    }

  // NOTE: inputs is intentionally NOT in the dependency array to prevent re-execution
  // if the parent component re-renders with a new inputs object reference. The inputs
  // are captured via inputsRef in the parent component and passed to the adapter.
  // Adding inputs here would cause the effect to re-run unnecessarily.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, tool.name, hasCompletedExecution, hasCompletedExecutionRef])

  return null
}

export const AssistantArchitectStreaming = memo(function AssistantArchitectStreaming({
  tool
}: AssistantArchitectStreamingProps) {
  const { toast } = useToast()
  const [promptCount, setPromptCount] = useState<number>(0)
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [inputs, setInputs] = useState<Record<string, unknown>>({})
  const [isExecuting, setIsExecuting] = useState(false)
  const [hasResults, setHasResults] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // CRITICAL FIX: Reset hasResults when tool changes (user navigates to different assistant)
  // This was causing the bug where hasResults stayed true from a previous session
  useEffect(() => {
    log.info('Tool changed - resetting execution state', { toolId: tool.id })
    setHasResults(false)
    setIsExecuting(false)
    setError(null)
  }, [tool.id])

  // Collect enabled tools from the assistant architect when component mounts
  useEffect(() => {
    const tools = tool.prompts ? collectAndSanitizeEnabledTools(tool.prompts) : []
    setEnabledTools(tools)
  }, [tool])

  // Create form schema based on tool input fields
  const formSchema = useMemo(() => z.object(
    tool.inputFields.reduce((acc: Record<string, z.ZodTypeAny>, field: SelectToolInputField) => {
      let fieldSchema: z.ZodString | z.ZodTypeAny

      switch (field.fieldType) {
        case "long_text":
        case "select":
        case "multi_select":
          fieldSchema = stringSchema
          break
        case "file_upload":
          fieldSchema = stringSchema
          break
        default:
          fieldSchema = stringSchema
      }

      // Make field optional by default
      fieldSchema = fieldSchema.optional().nullable()

      acc[field.name] = fieldSchema
      return acc
    }, {})
  ), [tool.inputFields])

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: tool.inputFields.reduce((acc: Record<string, string>, field: SelectToolInputField) => {
      acc[field.name] = ""
      return acc
    }, {})
  })

  // Handle form submission
  const onSubmit = useCallback(async (values: z.infer<typeof formSchema>) => {
    // Prevent re-execution if already running
    if (isExecuting) {
      return
    }

    // If we have completed results, confirm before re-running
    if (hasResults) {
      const confirmRerun = window.confirm(
        "You have existing results. Do you want to run the assistant again? This will clear your current results and chat."
      )
      if (!confirmRerun) {
        return
      }
      // Reset state for new execution
      setHasResults(false)
      setError(null)
    }

    try {
      setIsExecuting(true)
      setInputs(values)
      setError(null)

      log.info('Form submitted', { toolId: tool.id, inputs: Object.keys(values) })

      toast({
        title: "Execution Started",
        description: "The assistant architect is now executing"
      })
    } catch (submitError) {
      const errorMessage = submitError instanceof Error ? submitError.message : "Failed to start execution"
      setError(errorMessage)
      setIsExecuting(false)

      toast({
        title: "Execution Error",
        description: errorMessage,
        variant: "destructive"
      })
    }
  }, [isExecuting, hasResults, tool.id, toast])

  const handleExecutionIdChange = useCallback((newExecutionId: number) => {
    log.debug('Execution ID received', { executionId: newExecutionId })
  }, [])

  const handlePromptCountChange = useCallback((count: number) => {
    setPromptCount(count)
    log.debug('Prompt count received', { promptCount: count })
  }, [])

  const handleExecutionComplete = useCallback(() => {
    setIsExecuting(false)
    setHasResults(true)

    toast({
      title: "Execution Completed",
      description: "Assistant architect execution completed successfully"
    })
  }, [toast])

  const handleExecutionError = useCallback((errorMessage: string) => {
    setError(errorMessage)
    setIsExecuting(false)

    toast({
      title: "Execution Failed",
      description: errorMessage,
      variant: "destructive"
    })
  }, [toast])

  // Memoized components for better performance
  const ToolHeader = memo(({ tool }: { tool: AssistantArchitectWithRelations }) => {
    const safeImagePath = sanitizeImagePath(tool.imagePath)

    return (
      <div>
        <div className="flex items-start gap-4">
          {safeImagePath && (
            <div className="relative w-32 h-32 rounded-xl overflow-hidden flex-shrink-0 bg-muted/20 p-1">
              <div className="relative w-full h-full rounded-lg overflow-hidden ring-1 ring-black/10">
                <Image
                  src={`/assistant_logos/${safeImagePath}`}
                  alt={tool.name}
                  fill
                  className="object-cover"
                />
              </div>
            </div>
          )}
          <div>
            <h2 className="text-2xl font-bold">{tool.name}</h2>
            <p className="text-muted-foreground">{tool.description}</p>
          </div>
        </div>
        <div className="h-px bg-border mt-6" />
      </div>
    )
  })

  const ErrorAlert = memo(({ errorMessage }: { errorMessage: string }) => (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Execution Error</AlertTitle>
      <AlertDescription className="mt-2 text-sm">
        {errorMessage}
      </AlertDescription>
    </Alert>
  ))

  // Add display names to memoized components
  ToolHeader.displayName = "ToolHeader"
  ErrorAlert.displayName = "ErrorAlert"

  return (
    <div className="space-y-6">
      <ToolHeader tool={tool} />

      {error && (
        <ErrorAlert errorMessage={error} />
      )}

      <div className="space-y-4">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {tool.inputFields.map((field: SelectToolInputField) => (
              <FormField
                key={field.id}
                control={form.control}
                name={field.name}
                render={({ field: formField }) => (
                  <FormItem>
                    <FormLabel>{field.label || field.name}</FormLabel>
                    <FormControl>
                      {field.fieldType === "long_text" ? (
                        <Textarea
                          placeholder="Enter your answer..."
                          {...formField}
                          value={typeof formField.value === 'string' ? formField.value : ''}
                          className="bg-muted"
                          disabled={isExecuting}
                        />
                      ) : field.fieldType === "select" || field.fieldType === "multi_select" ? (
                        <Select
                          onValueChange={formField.onChange}
                          defaultValue={typeof formField.value === 'string' ? formField.value : undefined}
                          disabled={isExecuting}
                        >
                          <SelectTrigger className="bg-muted">
                            <SelectValue placeholder={`Select ${field.label || field.name}...`} />
                          </SelectTrigger>
                          <SelectContent>
                            {(() => {
                              let options: Array<{ label: string, value: string }> = []
                              if (typeof field.options === "string") {
                                try {
                                  const parsed = JSON.parse(field.options)
                                  if (Array.isArray(parsed)) {
                                    options = parsed
                                  }
                                } catch {
                                  const optionsStr = field.options as string
                                  options = optionsStr.split(",").map(s => ({
                                    value: s.trim(),
                                    label: s.trim()
                                  }))
                                }
                              } else if (Array.isArray(field.options)) {
                                options = field.options
                              } else if (field.options && typeof field.options === 'object' && 'values' in field.options) {
                                const optionsObj = field.options as { values?: string[] }
                                if (Array.isArray(optionsObj.values)) {
                                  options = optionsObj.values.map(val => ({
                                    label: val,
                                    value: val
                                  }))
                                }
                              }
                              // Sanitize option labels and filter out invalid ones
                              const sanitizedOptions = options
                                .map(opt => ({
                                  ...opt,
                                  label: sanitizeOptionLabel(opt.label)
                                }))
                                .filter(opt => opt.label !== '')

                              return sanitizedOptions.map(option => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))
                            })()}
                          </SelectContent>
                        </Select>
                      ) : field.fieldType === "file_upload" ? (
                        <DocumentUploadButton
                          label="Add Document for Knowledge"
                          onContent={doc => formField.onChange(doc)}
                          disabled={isExecuting}
                          className="w-full"
                          onError={err => {
                            if (err?.status === 413) {
                              toast({
                                title: "File Too Large",
                                description: "Please upload a file smaller than 50MB.",
                                variant: "destructive"
                              })
                            } else {
                              toast({
                                title: "Upload Failed",
                                description: err?.message || "Unknown error",
                                variant: "destructive"
                              })
                            }
                          }}
                        />
                      ) : (
                        <Input
                          placeholder="Enter your answer..."
                          {...formField}
                          value={typeof formField.value === 'string' ? formField.value : ''}
                          className="bg-muted"
                          disabled={isExecuting}
                        />
                      )}
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            <div className="flex gap-2">
              <Button type="submit" disabled={isExecuting}>
                {isExecuting ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running...</>
                ) : (
                  <><Sparkles className="mr-2 h-4 w-4" /> Generate</>
                )}
              </Button>
            </div>
          </form>
        </Form>

        {/* Schedule Modal moved outside the form to prevent event bubbling */}
        <ScheduleModal
          tool={tool}
          inputData={form.getValues()}
          onScheduleCreated={() => {
            toast({
              title: "Schedule Created",
              description: "Your assistant execution has been scheduled successfully."
            })
          }}
        />
      </div>

      {/* Tool Usage Indicators */}
      {enabledTools.length > 0 && (
        <div className="tool-execution-status space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Settings className="h-4 w-4" />
            <span>Tools Available ({enabledTools.length})</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {enabledTools.map(toolName => (
              <Badge key={toolName} variant="outline" className="text-xs">
                {getToolDisplayName(toolName)}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Streaming execution section - Thread remains visible after completion */}
      {(isExecuting || hasResults) && (
        <ErrorBoundary>
          <AssistantArchitectRuntimeProvider
            tool={tool}
            inputs={inputs}
            onExecutionIdChange={handleExecutionIdChange}
            onPromptCountChange={handlePromptCountChange}
            onExecutionComplete={handleExecutionComplete}
            onExecutionError={handleExecutionError}
            hasCompletedExecution={hasResults}
          >
            <div className="space-y-6">
              {/* Progress indicator for multi-prompt execution */}
              {promptCount > 1 && isExecuting && (
                <ExecutionProgress
                  totalPrompts={promptCount}
                  prompts={tool.prompts || []}
                />
              )}

              {/* Execution in-progress status banner */}
              {isExecuting && !hasResults && (
                <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Execution in progress — follow-up available when complete</span>
                </div>
              )}

              {/* Thread component for streaming output and follow-up conversations */}
              <div className="border rounded-lg p-4 space-y-4 max-w-full">
                <Thread />
              </div>
            </div>
          </AssistantArchitectRuntimeProvider>
        </ErrorBoundary>
      )}
    </div>
  )
})
