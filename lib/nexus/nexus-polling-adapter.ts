import type { ChatModelAdapter } from '@assistant-ui/react'
import { createLogger } from '@/lib/client-logger'
import { generateUUID } from '@/lib/utils/uuid'

const log = createLogger({ moduleName: 'nexus-polling-adapter' })

export interface NexusJobResponse {
  jobId: string
  conversationId: string
  status: 'pending' | 'processing' | 'streaming' | 'completed' | 'failed' | 'cancelled'
  partialContent?: string
  responseData?: {
    text: string
    type?: 'text' | 'image'
    s3Key?: string // S3 key for generated images (secure access via API)
    mediaType?: string // MIME type for images
    prompt?: string // Original prompt for image generation
    size?: string // Image size
    style?: string // Image style
    model?: string // Model used for generation
    usage?: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    }
    finishReason: string
    metadata?: Record<string, unknown> // Additional metadata
  }
  errorMessage?: string
  pollingInterval: number
  shouldContinuePolling: boolean
  requestId: string
}

export interface NexusPollingAdapterOptions {
  apiUrl: string
  bodyFn?: () => Record<string, unknown>
  maxPollAttempts?: number
  pollTimeoutMs?: number
  conversationId?: string
  onConversationIdChange?: (conversationId: string) => void
}

type NexusAdapterContent =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string }

function completedJobContent(
  jobData: NexusJobResponse,
  jobId: string
): { content: NexusAdapterContent[] } | null {
  if (!jobData.responseData) return null

  if (jobData.responseData.type === 'image' && jobData.responseData.s3Key) {
    const { s3Key, prompt, size, model } = jobData.responseData
    const imageUrl = `/api/images/${s3Key}`
    log.info('Image generation job completed', {
      jobId,
      prompt: prompt?.substring(0, 50) + (prompt && prompt.length > 50 ? '...' : ''),
      size,
      model,
      s3Key,
      imageUrl
    })
    return { content: [{ type: 'image', image: imageUrl }] }
  }

  const finalText =
    jobData.responseData.text ||
    jobData.partialContent ||
    'Response completed.'
  log.info('Text job completed successfully', {
    jobId,
    textLength: finalText.length,
    usage: jobData.responseData.usage
  })
  return { content: [{ type: 'text', text: finalText }] }
}

function appendAttachmentPart(
  parts: Array<Record<string, unknown>>,
  attachmentPart: { type: string; image?: string; url?: string; mediaType?: string }
): void {
  if (attachmentPart.type === 'image' && attachmentPart.image) {
    parts.push({ type: 'image', image: attachmentPart.image })
  } else if (attachmentPart.type === 'file' && attachmentPart.url) {
    parts.push({
      type: 'file',
      url: attachmentPart.url,
      mediaType: attachmentPart.mediaType
    })
  } else {
    parts.push(attachmentPart)
  }
}

/**
 * Nexus Polling Adapter for assistant-ui
 *
 * Converts the universal polling architecture into a streaming interface
 * that's compatible with assistant-ui's LocalRuntime.
 *
 * Flow:
 * 1. Submit chat request → get 202 + jobId
 * 2. Poll job status endpoint → get progressive updates
 * 3. Convert polling updates → streaming format for assistant-ui
 * 4. Handle completion/errors → final response
 */
export function createNexusPollingAdapter(options: NexusPollingAdapterOptions): ChatModelAdapter {
  const runtime: PollingRuntime = {
    apiUrl: options.apiUrl,
    bodyFn: options.bodyFn ?? (() => ({})),
    maxPollAttempts: options.maxPollAttempts ?? 300,
    pollTimeoutMs: options.pollTimeoutMs ?? 30000,
    conversation: { current: options.conversationId ?? null },
    onConversationIdChange: options.onConversationIdChange,
  }
  return {
    run(input) {
      return runPollingAdapter(runtime, input)
    }
  }
}

type AdapterRunInput = Parameters<ChatModelAdapter["run"]>[0]

interface PollingRuntime {
  apiUrl: string
  bodyFn: () => Record<string, unknown>
  maxPollAttempts: number
  pollTimeoutMs: number
  conversation: { current: string | null }
  onConversationIdChange?: (conversationId: string) => void
}

async function* runPollingAdapter(
  runtime: PollingRuntime,
  input: AdapterRunInput
): ReturnType<ChatModelAdapter["run"]> {
  logAdapterStart(input.messages, runtime.apiUrl)
  let jobId: string | null = null
  try {
    const processedMessages = processAdapterMessages(input.messages)
    logProcessedMessages(input.messages.length, processedMessages)
    jobId = await submitPollingJob(runtime, processedMessages, input.abortSignal)
    yield* pollNexusJob(runtime, jobId, input.abortSignal)
  } catch (error) {
    log.error('Nexus polling adapter error', {
      jobId,
      error: error instanceof Error
        ? { message: error.message, name: error.name }
        : String(error)
    })
    throw error
  }
}

function logAdapterStart(
  messages: AdapterRunInput["messages"],
  apiUrl: string
): void {
  log.info('NEXUS POLLING ADAPTER - Starting chat request', {
    messageCount: messages.length,
    apiUrl,
    messagesStructure: messages.map(message => ({
      role: message.role,
      hasContent: !!message.content,
      contentType: typeof message.content,
      contentLength: Array.isArray(message.content) ? message.content.length : 0,
      contentTypes: Array.isArray(message.content)
        ? message.content.map(part => part?.type)
        : []
    }))
  })
}

function processAdapterMessages(messages: AdapterRunInput["messages"]) {
  return messages.map(message => {
    const parts: Array<Record<string, unknown>> = []
    appendMessageContent(parts, message.content)
    appendMessageAttachments(parts, message)
    return {
      id: message.id || generateUUID(),
      role: message.role,
      parts: parts.length > 0 ? parts : [{ type: 'text', text: '' }]
    }
  })
}

function appendMessageContent(
  parts: Array<Record<string, unknown>>,
  content: AdapterRunInput["messages"][number]["content"]
): void {
  if (typeof content === 'string') {
    parts.push({ type: 'text', text: content })
    return
  }
  if (!Array.isArray(content)) return
  for (const contentPart of content) {
    if (contentPart.type === 'text') {
      parts.push({ type: 'text', text: contentPart.text })
    } else if (contentPart.type === 'image') {
      parts.push({ type: 'image', image: contentPart.image })
    } else if (contentPart.type === 'file') {
      parts.push({
        type: 'file',
        url: contentPart.url,
        mediaType: contentPart.mediaType
      })
    } else {
      parts.push(contentPart)
    }
  }
}

function appendMessageAttachments(
  parts: Array<Record<string, unknown>>,
  message: AdapterRunInput["messages"][number]
): void {
  const withAttachments = message as {
    attachments?: Array<{
      content?: Array<{
        type: string
        image?: string
        url?: string
        mediaType?: string
      }>
    }>
  }
  for (const attachment of withAttachments.attachments ?? []) {
    for (const attachmentPart of attachment.content ?? []) {
      appendAttachmentPart(parts, attachmentPart)
    }
  }
}

type ProcessedMessages = ReturnType<typeof processAdapterMessages>

function logProcessedMessages(
  originalCount: number,
  processedMessages: ProcessedMessages
): void {
  log.debug('Processed messages for API', {
    originalCount,
    processedCount: processedMessages.length,
    processedStructure: processedMessages.map(message => ({
      role: message.role,
      partsCount: message.parts.length,
      partsTypes: message.parts.map(part => part.type)
    }))
  })
}

async function submitPollingJob(
  runtime: PollingRuntime,
  messages: ProcessedMessages,
  abortSignal: AbortSignal
): Promise<string> {
  const requestBody: Record<string, unknown> = {
    messages,
    ...runtime.bodyFn()
  }
  if (runtime.conversation.current) {
    requestBody.conversationId = runtime.conversation.current
  }
  const response = await fetch(runtime.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: abortSignal,
  })
  if (!response.ok) {
    throw new Error(`Chat request failed: ${response.status} ${response.statusText}`)
  }
  const data = await response.json() as { jobId?: string }
  if (!data.jobId) throw new Error('No jobId received from chat request')
  updateConversationState(runtime, response)
  log.info('Job created successfully', {
    jobId: data.jobId,
    conversationId: runtime.conversation.current
  })
  return data.jobId
}

function updateConversationState(runtime: PollingRuntime, response: Response): void {
  const nextId = response.headers.get('X-Conversation-Id')
  if (!nextId || nextId === runtime.conversation.current) return
  const previousId = runtime.conversation.current
  runtime.conversation.current = nextId
  runtime.onConversationIdChange?.(nextId)
  log.info('Conversation ID updated', { previousId, newId: nextId })
}

interface PollResult {
  outputs: Array<{ content: NexusAdapterContent[] }>
  pollingInterval: number
  action: 'continue' | 'complete' | 'cancelled' | 'stop'
}

async function* pollNexusJob(
  runtime: PollingRuntime,
  jobId: string,
  abortSignal: AbortSignal
): ReturnType<ChatModelAdapter["run"]> {
  let pollingInterval = 1000
  for (let attempt = 1; attempt <= runtime.maxPollAttempts; attempt += 1) {
    if (abortSignal.aborted) {
      await cancelPollingJob(runtime.apiUrl, jobId)
      return
    }
    if (attempt > 1) await delay(pollingInterval)
    const result = await pollWithRetryPolicy(runtime, jobId, attempt)
    if (!result) continue
    pollingInterval = result.pollingInterval || pollingInterval
    for (const output of result.outputs) yield output
    if (result.action === 'complete' || result.action === 'cancelled') return
    if (result.action === 'stop') break
  }
  throw new Error(`Job polling timed out after ${runtime.maxPollAttempts} attempts`)
}

async function pollWithRetryPolicy(
  runtime: PollingRuntime,
  jobId: string,
  attempt: number
): Promise<PollResult | null> {
  try {
    return interpretPollResponse(await fetchPollingJob(runtime, jobId), jobId)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      log.debug('Poll request timed out, will retry', { jobId, attempt })
      return null
    }
    log.error('Poll request failed', {
      jobId,
      attempt,
      error: error instanceof Error ? error.message : String(error)
    })
    if (attempt < runtime.maxPollAttempts) return null
    throw error
  }
}

async function fetchPollingJob(
  runtime: PollingRuntime,
  jobId: string
): Promise<NexusJobResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), runtime.pollTimeoutMs)
  try {
    const response = await fetch(`${runtime.apiUrl}/jobs/${jobId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 404) {
      throw new Error('Job not found - it may have expired')
    }
    if (!response.ok) {
      throw new Error(`Poll request failed: ${response.status} ${response.statusText}`)
    }
    return await response.json() as NexusJobResponse
  } finally {
    clearTimeout(timeout)
  }
}

function interpretPollResponse(
  jobData: NexusJobResponse,
  jobId: string
): PollResult {
  log.debug('Poll response received', {
    jobId,
    status: jobData.status,
    hasPartialContent: !!jobData.partialContent,
    shouldContinuePolling: jobData.shouldContinuePolling
  })
  const outputs: PollResult["outputs"] = jobData.partialContent
    ? [{ content: [{ type: 'text' as const, text: jobData.partialContent }] }]
    : []
  if (jobData.status === 'completed') {
    const finalOutput = completedJobContent(jobData, jobId)
    if (finalOutput) outputs.push(finalOutput)
    return { outputs, pollingInterval: jobData.pollingInterval, action: 'complete' }
  }
  if (jobData.status === 'failed') {
    const message = jobData.errorMessage || 'Job processing failed'
    log.error('Job failed', { jobId, errorMessage: message })
    throw new Error(message)
  }
  if (jobData.status === 'cancelled') {
    log.info('Job was cancelled', { jobId })
    return { outputs, pollingInterval: jobData.pollingInterval, action: 'cancelled' }
  }
  if (!jobData.shouldContinuePolling) {
    log.warn('Server indicated to stop polling but job not completed', {
      jobId,
      status: jobData.status
    })
    return { outputs, pollingInterval: jobData.pollingInterval, action: 'stop' }
  }
  return { outputs, pollingInterval: jobData.pollingInterval, action: 'continue' }
}

async function cancelPollingJob(apiUrl: string, jobId: string): Promise<void> {
  try {
    await fetch(`${apiUrl}/jobs/${jobId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    })
    log.info('Job cancelled due to abort signal', { jobId })
  } catch (error) {
    log.warn('Failed to cancel job', { jobId, error })
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
