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
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useState, useEffect, useCallback, memo, useMemo, useRef, startTransition } from "react"
import { useToast } from "@/components/ui/use-toast"
import { SelectToolInputField } from "@/types/db-types"
import { Loader2, Sparkles, AlertCircle, Settings } from "lucide-react"
import { ErrorBoundary } from "@/components/error-boundary"
import type { AssistantArchitectWithRelations } from "@/types/assistant-architect-types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { collectAndSanitizeEnabledTools, getToolDisplayName } from '@/lib/assistant-architect/tool-utils'
import Image from "next/image"
import DocumentUploadButton from "@/components/ui/document-upload-button"
import { AssistantRuntimeProvider, useThreadRuntime, useLocalRuntime, type ChatModelRunOptions, type ChatModelRunResult } from '@assistant-ui/react'
import { Thread } from '@/components/assistant-ui/thread'
import { createLogger } from '@/lib/client-logger'
import { ExecutionProgress } from './execution-progress'
import { ToolCallTimeline } from './tool-call-timeline'
import {
  parseSSEEvent,
  isTextDeltaEvent,
  isTextStartEvent,
  isTextEndEvent,
  isReasoningStartEvent,
  isReasoningDeltaEvent,
  isReasoningEndEvent,
  isStartStepEvent,
  isStartEvent,
  isFinishStepEvent,
  isToolCallEvent,
  isToolCallDeltaEvent,
  isToolInputStartEvent,
  isToolInputDeltaEvent,
  isToolInputAvailableEvent,
  isToolInputErrorEvent,
  isToolOutputErrorEvent,
  isToolOutputAvailableEvent,
  isErrorEvent,
  isMessageEvent,
  isAssistantMessageEvent,
  isFinishEvent,
  isSourceUrlEvent,
  type SSEEvent
} from '@/lib/streaming/sse-event-types'
import { createSSEMonitor } from '@/lib/streaming/sse-monitoring'
import { validateSSEEvent } from '@/lib/streaming/sse-event-schemas'
import { processUnknownEvent } from '@/lib/streaming/graceful-degradation'
import { sanitizeOptionLabel } from '@/lib/utils/sanitize-option-label'
import { isConfirmationRequiredText } from '@/lib/agents/confirmation'

const log = createLogger({ moduleName: 'assistant-architect-streaming' })

// Define base schema outside component to prevent re-creation on each render
const stringSchema = z.string()
type SelectOption = { label: string; value: string }

function normalizeSelectOptions(rawOptions: unknown): SelectOption[] {
  let options: SelectOption[] = []
  if (typeof rawOptions === "string") {
    try {
      const parsed: unknown = JSON.parse(rawOptions)
      if (Array.isArray(parsed)) options = parsed as SelectOption[]
    } catch {
      for (const value of rawOptions.split(",")) {
        options.push({ value: value.trim(), label: value.trim() })
      }
    }
  } else if (Array.isArray(rawOptions)) {
    options = rawOptions as SelectOption[]
  } else if (
    rawOptions &&
    typeof rawOptions === "object" &&
    "values" in rawOptions
  ) {
    const values = (rawOptions as { values?: string[] }).values
    if (Array.isArray(values)) {
      for (const value of values) options.push({ label: value, value })
    }
  }

  const sanitized: SelectOption[] = []
  for (const option of options) {
    const normalized = {
      ...option,
      label: sanitizeOptionLabel(option.label),
      value: sanitizeOptionLabel(option.value ?? option.label),
    }
    if (normalized.label !== "" && normalized.value !== "") {
      sanitized.push(normalized)
    }
  }
  return sanitized
}

function renderSelectOptions(rawOptions: unknown) {
  return normalizeSelectOptions(rawOptions).map((option) => (
    <SelectItem key={option.value} value={option.value}>
      {option.label}
    </SelectItem>
  ))
}

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
  onExecutionIdChangeRef: React.MutableRefObject<(id: number) => void>
  onPromptCountChangeRef: React.MutableRefObject<(count: number) => void>
  /**
   * Called for each tool-call lifecycle event so the UI can render an agentic
   * tool-call timeline (Issue #926). Held in a ref so the stable adapter never
   * re-initializes when the handler identity changes.
   */
  onToolEventRef: React.MutableRefObject<(event: ToolTimelineEvent) => void>
  /**
   * Per-run approval for destructive agent tools (Issue #926). Read at request
   * time so toggling it doesn't re-create the adapter.
   */
  approveDestructiveRef: React.MutableRefObject<boolean>
}

/** A single tool-call timeline entry surfaced to the execution UI (#926). */
export interface ToolTimelineEvent {
  toolCallId: string
  toolName: string
  /**
   * 'confirmation' = a destructive tool was gated pending human approval (it did
   * not run). The other phases are the normal call lifecycle. (#926.)
   */
  phase: 'call' | 'output' | 'error' | 'confirmation'
  /** Output/error/confirmation text when phase is not 'call'. */
  detail?: string
}

/**
 * Merge a tool-call event into the timeline: upsert by toolCallId, latest phase
 * wins, but a late 'call' never clobbers a terminal 'output'/'error'. Pure so the
 * setState updater stays a one-liner (keeps callback nesting shallow).
 */
function mergeToolTimelineEvent(
  prev: ToolTimelineEvent[],
  event: ToolTimelineEvent
): ToolTimelineEvent[] {
  const idx = prev.findIndex(e => e.toolCallId === event.toolCallId)
  if (idx === -1) return [...prev, event]
  const existing = prev[idx]
  if (existing.phase !== 'call' && event.phase === 'call') return prev
  const next = [...prev]
  // Output/error SSE events don't carry the tool name (the AI SDK omits it on
  // those parts), so they arrive with the placeholder 'tool'. Preserve the real
  // name captured at the 'call' phase rather than clobbering it. (PR review.)
  const toolName =
    event.toolName && event.toolName !== 'tool' ? event.toolName : existing.toolName
  next[idx] = { ...existing, ...event, toolName }
  return next
}

/**
 * Build the timeline event for a tool-output-available SSE event. A destructive
 * tool gated for confirmation returns a sentinel-prefixed string instead of
 * running (#926); surface it as a distinct 'confirmation' state. (Module-level so
 * the streaming generator stays a single call site.)
 */
function toolOutputTimelineEvent(
  toolCallId: string,
  output: unknown
): ToolTimelineEvent {
  const gated = isConfirmationRequiredText(output)
  return {
    toolCallId,
    toolName: 'tool',
    phase: gated ? 'confirmation' : 'output',
    ...(gated ? { detail: 'Awaiting confirmation — destructive action not run' } : {}),
  }
}

interface ArchitectStreamContext {
  accumulatedText: string
  sources: Array<{ id: string; url: string; title?: string }>
  monitor: ReturnType<typeof createSSEMonitor>
  onToolEvent: (event: ToolTimelineEvent) => void
}

interface EventHandlingResult {
  handled: boolean
  output?: ChatModelRunResult
}

interface LineHandlingResult {
  done: boolean
  output?: ChatModelRunResult
}

function textStreamOutput(text: string): ChatModelRunResult {
  return {
    content: [{ type: 'text' as const, text }]
  }
}

function recordEventValidation(
  event: SSEEvent,
  monitor: ReturnType<typeof createSSEMonitor>
): void {
  const validation = validateSSEEvent(event)
  if (validation.success || !validation.error) return

  log.warn('SSE event validation failed', {
    type: event.type,
    error: validation.error.message,
    hint: validation.error.hint
  })
  if (validation.error.hint?.includes('Field name mismatch')) {
    monitor.recordFieldMismatch('delta', Object.keys(event), event.type)
  }
}

function handleNarrativeEvent(
  event: SSEEvent,
  context: ArchitectStreamContext
): EventHandlingResult {
  if (isTextDeltaEvent(event)) {
    context.monitor.validateEventFields(event, ['delta'])
    context.accumulatedText += event.delta
    log.debug('✅ YIELDED text-delta', {
      deltaLength: event.delta.length,
      totalLength: context.accumulatedText.length
    })
    return { handled: true, output: textStreamOutput(context.accumulatedText) }
  }
  if (isTextStartEvent(event)) {
    log.debug('Text stream started', { id: event.id })
    return { handled: true }
  }
  if (isTextEndEvent(event)) {
    log.debug('Text stream ended', { id: event.id })
    return { handled: true }
  }
  if (isReasoningStartEvent(event)) {
    log.debug('Reasoning started', { id: event.id })
    return { handled: true }
  }
  if (isReasoningDeltaEvent(event)) {
    log.debug('Reasoning delta received', { delta: event.delta?.slice(0, 50) })
    return { handled: true }
  }
  if (isReasoningEndEvent(event)) {
    log.debug('Reasoning completed', { id: event.id })
    return { handled: true }
  }
  if (isStartStepEvent(event) || isStartEvent(event)) {
    log.debug('Step started')
    return { handled: true }
  }
  if (isFinishStepEvent(event)) {
    log.debug('Step finished')
    return { handled: true }
  }
  return { handled: false }
}

function handleToolInputEvent(
  event: SSEEvent,
  context: ArchitectStreamContext
): EventHandlingResult {
  if (isToolCallEvent(event) || isToolCallDeltaEvent(event)) {
    log.debug('Tool call received', {
      toolName: event.toolName,
      type: event.type
    })
    context.onToolEvent({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      phase: 'call',
    })
    return { handled: true }
  }
  if (isToolInputStartEvent(event)) {
    log.debug('Tool input started', {
      toolCallId: event.toolCallId,
      toolName: event.toolName
    })
    context.onToolEvent({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      phase: 'call',
    })
    return { handled: true }
  }
  if (isToolInputDeltaEvent(event)) {
    log.debug('Tool input delta', { toolCallId: event.toolCallId })
    return { handled: true }
  }
  if (isToolInputAvailableEvent(event)) {
    log.debug('Tool input available', { toolCallId: event.toolCallId })
    return { handled: true }
  }
  if (isToolInputErrorEvent(event)) {
    log.debug('Tool input error', {
      toolCallId: event.toolCallId,
      toolName: event.toolName
    })
    context.onToolEvent({
      toolCallId: event.toolCallId,
      toolName: event.toolName ?? 'tool',
      phase: 'error',
      detail: 'Tool input error',
    })
    return { handled: true }
  }
  return { handled: false }
}

function handleToolOutputEvent(
  event: SSEEvent,
  context: ArchitectStreamContext
): EventHandlingResult {
  if (isToolOutputErrorEvent(event)) {
    log.debug('Tool output error', {
      toolCallId: event.toolCallId,
      errorText: event.errorText
    })
    context.onToolEvent({
      toolCallId: event.toolCallId,
      toolName: 'tool',
      phase: 'error',
      detail: event.errorText ?? 'Tool output error',
    })
    return { handled: true }
  }
  if (isToolOutputAvailableEvent(event)) {
    log.debug('Tool output available', { toolCallId: event.toolCallId })
    context.onToolEvent(toolOutputTimelineEvent(event.toolCallId, event.output))
    return { handled: true }
  }
  if (isErrorEvent(event)) {
    log.error('Stream error received', { error: event.error })
    throw new Error(event.error || 'Stream error')
  }
  return { handled: false }
}

function handleTerminalEvent(
  event: SSEEvent,
  context: ArchitectStreamContext
): EventHandlingResult {
  if (isMessageEvent(event) || isAssistantMessageEvent(event)) {
    log.info('Received message event', { type: event.type })
    return handleCompleteMessageText(
      event.parts?.find(part => part.type === 'text')?.text,
      context,
      'message event'
    )
  }
  if (isFinishEvent(event)) {
    log.info('Received finish event')
    return handleCompleteMessageText(
      event.message?.parts?.find(part => part.type === 'text')?.text,
      context,
      'finish event'
    )
  }
  if (isSourceUrlEvent(event)) {
    context.sources.push({
      id: event.sourceId,
      url: event.url,
      title: event.title
    })
    log.debug('Source URL collected', { sourceId: event.sourceId })
    return { handled: true }
  }
  return { handled: false }
}

function handleCompleteMessageText(
  text: string | undefined,
  context: ArchitectStreamContext,
  eventLabel: string
): EventHandlingResult {
  if (!text) return { handled: true }

  context.accumulatedText = text
  log.debug(`✅ YIELDED content from ${eventLabel}`, {
    textLength: context.accumulatedText.length
  })
  return { handled: true, output: textStreamOutput(context.accumulatedText) }
}

function handleUnknownArchitectEvent(
  event: SSEEvent,
  context: ArchitectStreamContext
): EventHandlingResult {
  const unknownEvent = event as unknown as Record<string, unknown>
  log.warn('⚠️ UNHANDLED SSE EVENT TYPE', {
    type: unknownEvent['type'],
    keys: Object.keys(unknownEvent),
    sample: JSON.stringify(unknownEvent).substring(0, 200)
  })
  const unknownContext = {
    accumulatedText: context.accumulatedText,
    monitor: context.monitor,
    verbose: process.env.NODE_ENV === 'development'
  }
  if (!processUnknownEvent(unknownEvent, unknownContext)) {
    return { handled: true }
  }

  context.accumulatedText = unknownContext.accumulatedText
  log.debug('✅ YIELDED content from unknown event', {
    type: unknownEvent['type'],
    textLength: context.accumulatedText.length
  })
  return { handled: true, output: textStreamOutput(context.accumulatedText) }
}

function handleArchitectEvent(
  event: SSEEvent,
  context: ArchitectStreamContext
): ChatModelRunResult | undefined {
  context.monitor.recordEvent(event.type)
  recordEventValidation(event, context.monitor)

  const narrative = handleNarrativeEvent(event, context)
  if (narrative.handled) return narrative.output
  const toolInput = handleToolInputEvent(event, context)
  if (toolInput.handled) return toolInput.output
  const toolOutput = handleToolOutputEvent(event, context)
  if (toolOutput.handled) return toolOutput.output
  const terminal = handleTerminalEvent(event, context)
  if (terminal.handled) return terminal.output
  return handleUnknownArchitectEvent(event, context).output
}

function processArchitectSseLine(
  line: string,
  context: ArchitectStreamContext
): LineHandlingResult {
  if (!line.trim() || line.startsWith(':') || !line.startsWith('data: ')) {
    return { done: false }
  }

  const data = line.slice(6)
  if (data === '[DONE]') return { done: true }

  try {
    return {
      done: false,
      output: handleArchitectEvent(parseSSEEvent(data), context)
    }
  } catch (error) {
    context.monitor.recordParseError(
      error instanceof Error ? error : new Error(String(error)),
      data
    )
    log.warn('Failed to parse SSE data', {
      data: data.substring(0, 100),
      error: error instanceof Error ? error.message : String(error)
    })
    return { done: false }
  }
}

function* processArchitectSseLines(
  lines: string[],
  context: ArchitectStreamContext
): Generator<ChatModelRunResult> {
  for (const line of lines) {
    const result = processArchitectSseLine(line, context)
    if (result.output) yield result.output
    if (result.done) return
  }
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
    onExecutionIdChangeRef,
    onPromptCountChangeRef,
    onToolEventRef,
    approveDestructiveRef
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
            inputs: inputsRef.current,
            // Per-run approval for destructive agent tools (#926); ignored in
            // prompt-chain mode by the route.
            approveDestructiveTools: approveDestructiveRef.current === true
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
          onExecutionIdChangeRef.current(Number(executionId))
          log.info('Execution started', { executionId, promptCount })
        }

        if (promptCount) {
          onPromptCountChangeRef.current(Number(promptCount))
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
        const streamContext: ArchitectStreamContext = {
          accumulatedText: '',
          sources: [],
          monitor: createSSEMonitor({
            executionId: executionIdRef.current || undefined,
            toolId
          }),
          onToolEvent: onToolEventRef.current
        }

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            yield* processArchitectSseLines(lines, streamContext)
          }

          // Final yield with complete accumulated text and any collected sources
          if (streamContext.accumulatedText || streamContext.sources.length > 0) {
            yield {
              content: [
                ...(streamContext.accumulatedText
                  ? [{ type: 'text' as const, text: streamContext.accumulatedText }]
                  : []),
                ...streamContext.sources.map(source => ({
                  type: 'source' as const,
                  sourceType: 'url' as const,
                  id: source.id,
                  url: source.url,
                  title: source.title
                }))
              ]
            }
          }

          // Complete monitoring and log metrics locally
          const metrics = streamContext.monitor.complete()

          log.info('Streaming completed successfully', {
            totalLength: streamContext.accumulatedText.length,
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
  hasCompletedExecution,
  onToolEvent,
  approveDestructive
}: {
  children: React.ReactNode
  tool: AssistantArchitectWithRelations
  inputs: Record<string, unknown>
  onExecutionIdChange: (executionId: number) => void
  onPromptCountChange: (count: number) => void
  onExecutionComplete: () => void
  onExecutionError: (error: string) => void
  hasCompletedExecution: boolean
  onToolEvent: (event: ToolTimelineEvent) => void
  approveDestructive: boolean
}) {
  const inputsRef = useRef(inputs)

  useEffect(() => {
    inputsRef.current = inputs
  }, [inputs])

  // Use refs for callbacks to avoid dependency issues
  const onExecutionIdChangeRef = useRef(onExecutionIdChange)
  const onPromptCountChangeRef = useRef(onPromptCountChange)
  const onToolEventRef = useRef(onToolEvent)
  // Per-run destructive-tool approval, read at request time (#926).
  const approveDestructiveRef = useRef(approveDestructive)

  useEffect(() => {
    onExecutionIdChangeRef.current = onExecutionIdChange
    onPromptCountChangeRef.current = onPromptCountChange
    onToolEventRef.current = onToolEvent
    approveDestructiveRef.current = approveDestructive
  }, [onExecutionIdChange, onPromptCountChange, onToolEvent, approveDestructive])

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

  // Create adapter in effect to avoid accessing refs during render.
  // The adapter captures refs and reads .current at call time inside the async generator.
  const [adapter, setAdapter] = useState<ReturnType<typeof createAssistantArchitectAdapter> | null>(null)

  const currentToolId = tool.id
  useEffect(() => {
    const newAdapter = createAssistantArchitectAdapter({
      toolId: currentToolId,
      inputsRef,
      hasCompletedExecutionRef,
      executionIdRef,
      conversationIdRef,
      executionModelRef,
      onExecutionIdChangeRef,
      onPromptCountChangeRef,
      onToolEventRef,
      approveDestructiveRef
    })
    startTransition(() => { setAdapter(newAdapter) })
  }, [currentToolId])

  // Use LocalRuntime with stable adapter reference
  // Adapter is null only on first render before the effect fires
  const runtime = useLocalRuntime(adapter!)

  if (!adapter) return null

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
  // Capture inputs in a ref so the effect can log them without depending on the
  // object reference (which changes on every parent render and would reset hasStarted).
  const inputsRef = useRef(inputs)
  useEffect(() => { inputsRef.current = inputs })

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
        log.info('Execution started', { toolName: tool.name, inputKeys: Object.keys(inputsRef.current) })
      }, 0)

      // Cleanup: clear timeout and reset hasStarted so StrictMode remount can restart
      return () => {
        clearTimeout(timeoutId)
        hasStarted.current = false
      }
    }
  }, [runtime, tool.name, hasCompletedExecution, hasCompletedExecutionRef])

  return null
}

// Module-level memoized components (must be defined outside component to avoid
// "Cannot create components during render" React Compiler error)
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
ToolHeader.displayName = "ToolHeader"

const ErrorAlert = memo(({ errorMessage }: { errorMessage: string }) => (
  <Alert variant="destructive">
    <AlertCircle className="h-4 w-4" />
    <AlertTitle>Execution Error</AlertTitle>
    <AlertDescription className="mt-2 text-sm">
      {errorMessage}
    </AlertDescription>
  </Alert>
))
ErrorAlert.displayName = "ErrorAlert"

/**
 * Per-run destructive-tool approval toggle (Issue #926). Renders nothing unless
 * the assistant is agentic and exposes at least one tool. Default is unchecked:
 * destructive tools are gated behind a confirmation message and skipped at runtime
 * unless the executing user opts in here.
 */
const DestructiveApprovalToggle = memo(function DestructiveApprovalToggle({
  tool,
  isAgentic,
  checked,
  onChange,
  disabled,
}: {
  tool: AssistantArchitectWithRelations
  isAgentic: boolean
  checked: boolean
  onChange: (checked: boolean) => void
  disabled: boolean
}) {
  const hasAgentTools = isAgentic && (tool.agentEnabledTools?.length ?? 0) > 0
  if (!hasAgentTools) return null
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2 text-sm">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        disabled={disabled}
        aria-label="Allow destructive tool actions for this run"
        className="mt-0.5"
      />
      <span className="text-muted-foreground">
        Allow destructive tool actions (e.g. writes, deletions) to run without
        per-action confirmation in this run. Leave unchecked to require approval —
        destructive tools will be skipped and reported.
      </span>
    </div>
  )
})
DestructiveApprovalToggle.displayName = "DestructiveApprovalToggle"

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
  // Agentic tool-call timeline (Issue #926). Latest phase per toolCallId wins so
  // a tool's row updates call -> output/error in place rather than duplicating.
  const [toolTimeline, setToolTimeline] = useState<ToolTimelineEvent[]>([])
  const isAgentic = tool.mode === 'agentic'
  // Per-run approval for destructive agent tools (#926). Default off: destructive
  // tools are gated behind confirmation unless the user opts in for this run.
  const [approveDestructive, setApproveDestructive] = useState(false)

  // Stable callback (no deps) so the ref-based adapter never re-initializes.
  // The merge is a module-level pure fn to keep nesting shallow.
  const handleToolEvent = useCallback((event: ToolTimelineEvent) => {
    setToolTimeline(prev => mergeToolTimelineEvent(prev, event))
  }, [])

  // CRITICAL FIX: Reset hasResults when tool changes (user navigates to different assistant)
  // This was causing the bug where hasResults stayed true from a previous session
  useEffect(() => {
    log.info('Tool changed - resetting execution state', { toolId: tool.id })
    startTransition(() => {
      setHasResults(false)
      setIsExecuting(false)
      setError(null)
      setToolTimeline([])
    })
  }, [tool.id])

  // Collect enabled tools from the assistant architect when component mounts
  useEffect(() => {
    const tools = tool.prompts ? collectAndSanitizeEnabledTools(tool.prompts) : []
    startTransition(() => { setEnabledTools(tools) })
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
                            {renderSelectOptions(field.options)}
                          </SelectContent>
                        </Select>
                      ) : field.fieldType === "file_upload" ? (
                        <DocumentUploadButton
                          label="Add Document for Knowledge"
                          onContent={doc => formField.onChange(doc)}
                          repositoryBacked
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
            <DestructiveApprovalToggle
              tool={tool}
              isAgentic={isAgentic}
              checked={approveDestructive}
              onChange={setApproveDestructive}
              disabled={isExecuting}
            />
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
            onToolEvent={handleToolEvent}
            approveDestructive={approveDestructive}
          >
            <div className="space-y-6">
              {/* Progress indicator for multi-prompt execution */}
              {promptCount > 1 && isExecuting && (
                <ExecutionProgress
                  totalPrompts={promptCount}
                  prompts={tool.prompts || []}
                />
              )}

              {/* Agentic tool-call timeline (Issue #926) */}
              {isAgentic && (
                <ToolCallTimeline events={toolTimeline} />
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
