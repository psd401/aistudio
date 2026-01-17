import { useRef, useEffect } from "react"
import { toast } from "sonner"

interface PollingOptions {
  maxAttempts?: number
  onSuccess: (extractedText: string, fileName: string) => void
  onError: (error: { status?: number; message?: string }) => void
  onStatusChange: (status: string) => void
}

const logError = (message: string, data?: Record<string, unknown>) => {
  console.error(`[DocumentUploadPolling] ${message}`, data)
}

export function useDocumentUploadPolling() {
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current)
        pollingTimeoutRef.current = null
      }
    }
  }, [])

  const cancelPolling = () => {
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current)
      pollingTimeoutRef.current = null
    }
  }

  const startPolling = async (jobId: string, fileName: string, options: PollingOptions) => {
    const { maxAttempts = 60, onSuccess, onError, onStatusChange } = options
    let attempts = 0
    let pollInterval = 1000

    const poll = async () => {
      try {
        if (attempts >= maxAttempts) {
          throw new Error('Processing timeout - document processing took too long')
        }

        const response = await fetch(`/api/documents/v2/jobs/${jobId}`)

        if (!response.ok) {
          throw new Error(`Failed to check job status: ${response.status}`)
        }

        const job = await response.json()

        if (job.status === 'completed') {
          cancelPolling()

          const result = job.result
          let extractedText = ''

          if (result && result.markdown) {
            extractedText = result.markdown
          } else if (result && result.text) {
            extractedText = result.text
          } else {
            throw new Error('No content extracted from document')
          }

          onSuccess(extractedText, fileName)

        } else if (job.status === 'failed') {
          cancelPolling()

          const errorMessage = job.error || job.errorMessage || 'Document processing failed'
          throw new Error(errorMessage)

        } else if (job.status === 'processing') {
          if (job.progress && job.processingStage) {
            onStatusChange(`Processing document... (${job.processingStage} - ${job.progress}%)`)
          } else {
            onStatusChange("Processing document...")
          }

          const nextInterval = Math.min(pollInterval * 1.2, 5000)
          const jitter = Math.random() * 0.2 + 0.9
          const jitteredInterval = nextInterval * jitter

          pollingTimeoutRef.current = setTimeout(poll, jitteredInterval)
          pollInterval = nextInterval
          attempts++
        } else {
          onStatusChange("Processing document...")
          const jitter = Math.random() * 0.2 + 0.9
          pollingTimeoutRef.current = setTimeout(poll, pollInterval * jitter)
          attempts++
        }

      } catch (error) {
        cancelPolling()

        const errorMessage = error instanceof Error ? error.message : "Failed to process document."

        logError('Polling error occurred', {
          error: error instanceof Error ? error.message : String(error),
          jobId,
          fileName,
          attempts,
          errorMessage
        })

        toast.error(errorMessage)

        const status = error instanceof Error && error.message.includes('status:')
          ? Number.parseInt(error.message.split('status:')[1])
          : undefined
        onError({ message: errorMessage, status })
      }
    }

    poll()
  }

  return { startPolling, cancelPolling }
}
