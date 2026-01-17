import { useRef, useEffect, useCallback } from "react"
import { toast } from "sonner"
import { createLogger } from "@/lib/logger"

const log = createLogger({ module: 'DocumentUploadPolling' })

interface PollingOptions {
  /** Max polling attempts. Default 120 for large files (500MB may take 5+ minutes) */
  maxAttempts?: number
  onSuccess: (extractedText: string, fileName: string) => void
  onError: (error: { status?: number; message?: string }) => void
  onStatusChange: (status: string) => void
}

interface JobResult {
  status: string
  result?: { markdown?: string; text?: string }
  error?: string
  errorMessage?: string
  progress?: number
  processingStage?: string
}

/** Extract text content from job result */
function extractTextFromResult(result: JobResult['result']): string {
  if (result?.markdown) return result.markdown
  if (result?.text) return result.text
  throw new Error('No content extracted from document')
}

/** Calculate next poll interval with jitter (±10%) to prevent thundering herd */
function getNextInterval(currentInterval: number): { interval: number; jitteredInterval: number } {
  const nextInterval = Math.min(currentInterval * 1.2, 5000)
  const jitter = Math.random() * 0.2 + 0.9
  return { interval: nextInterval, jitteredInterval: nextInterval * jitter }
}

/** Format progress status message */
function formatStatusMessage(job: JobResult): string {
  if (job.progress && job.processingStage) {
    return `Processing document... (${job.processingStage} - ${job.progress}%)`
  }
  return "Processing document..."
}

export function useDocumentUploadPolling() {
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Clean up polling and abort in-flight requests on unmount
  useEffect(() => {
    return () => {
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current)
        pollingTimeoutRef.current = null
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
    }
  }, [])

  const cancelPolling = useCallback(() => {
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current)
      pollingTimeoutRef.current = null
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  const startPolling = useCallback(async (jobId: string, fileName: string, options: PollingOptions) => {
    // Default 120 attempts with exponential backoff (1s→5s) allows ~8 minutes for large file processing
    const { maxAttempts = 120, onSuccess, onError, onStatusChange } = options
    let attempts = 0
    let pollInterval = 1000

    // Create new AbortController for this polling session
    abortControllerRef.current = new AbortController()

    const handleJobCompleted = (job: JobResult) => {
      cancelPolling()
      const extractedText = extractTextFromResult(job.result)
      onSuccess(extractedText, fileName)
    }

    const handleJobFailed = (job: JobResult) => {
      cancelPolling()
      throw new Error(job.error || job.errorMessage || 'Document processing failed')
    }

    const scheduleNextPoll = () => {
      const { interval, jitteredInterval } = getNextInterval(pollInterval)
      pollingTimeoutRef.current = setTimeout(poll, jitteredInterval)
      pollInterval = interval
      attempts++
    }

    const poll = async () => {
      try {
        if (attempts >= maxAttempts) {
          throw new Error('Processing timeout - document processing took too long')
        }

        const response = await fetch(`/api/documents/v2/jobs/${jobId}`, {
          signal: abortControllerRef.current?.signal
        })

        if (!response.ok) {
          throw new Error(`Failed to check job status: ${response.status}`)
        }

        const job: JobResult = await response.json()

        if (job.status === 'completed') {
          handleJobCompleted(job)
        } else if (job.status === 'failed') {
          handleJobFailed(job)
        } else {
          onStatusChange(formatStatusMessage(job))
          scheduleNextPoll()
        }

      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }

        cancelPolling()
        const errorMessage = error instanceof Error ? error.message : "Failed to process document."

        log.error('Polling error occurred', {
          error: error instanceof Error ? error.message : String(error),
          jobId,
          fileName,
          attempts
        })

        toast.error(errorMessage)
        onError({ message: errorMessage })
      }
    }

    poll()
  }, [cancelPolling])

  return { startPolling, cancelPolling }
}
