"use client"

import { useRef, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Loader2, FileUp, CheckCircle } from "lucide-react"
import { toast } from "sonner"
import { useDocumentUploadPolling } from "./hooks/use-document-upload-polling"
import {
  uploadViaServer,
  formatDocumentTag,
  getButtonText,
  SUPPORTED_FILE_TYPES,
  MAX_FILE_SIZE
} from "./utils/document-upload-helpers"

interface DocumentUploadButtonProps {
  onContent: (content: string) => void
  label?: string
  className?: string
  disabled?: boolean
  onError?: (err: { status?: number; message?: string }) => void
}

export default function DocumentUploadButton({
  onContent,
  label = "Add Document for Knowledge",
  className = "",
  disabled = false,
  onError
}: DocumentUploadButtonProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null)
  const [processingStatus, setProcessingStatus] = useState<string>("")
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const { startPolling, cancelPolling } = useDocumentUploadPolling()

  const handleButtonClick = useCallback(() => {
    if (fileInputRef.current) fileInputRef.current.value = ""
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate file type
    if (!SUPPORTED_FILE_TYPES.includes(file.type)) {
      const errorMessage = "Unsupported file type. Supported formats: PDF, Word, Excel, PowerPoint, Text, Markdown, CSV, JSON, XML, YAML"
      toast.error(errorMessage)
      onError?.({ message: errorMessage })
      return
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      const errorMessage = "File size exceeds 50MB limit."
      toast.error(errorMessage)
      onError?.({ message: errorMessage })
      return
    }

    cancelPolling()
    setIsLoading(true)
    setUploadedFileName(null)
    setProcessingStatus("Uploading...")

    try {
      const { jobId } = await uploadViaServer(file)
      setProcessingStatus("Processing document...")

      startPolling(jobId, file.name, {
        onSuccess: (extractedText, fileName) => {
          onContent(formatDocumentTag(extractedText, fileName))
          setUploadedFileName(fileName)
          toast.success("Document content added to system context.")
          setIsLoading(false)
          setProcessingStatus("")
        },
        onError: (err) => {
          onError?.(err)
          setUploadedFileName(null)
          setIsLoading(false)
          setProcessingStatus("")
        },
        onStatusChange: setProcessingStatus
      })

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to process document."

      // Client-side error logging (server-side logger not available in client components)
      console.error('[DocumentUploadButton] Upload error:', {
        error: err instanceof Error ? err.message : String(err),
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type
      })

      toast.error(errorMessage)
      onError?.({ message: errorMessage })
      setUploadedFileName(null)
      setIsLoading(false)
      setProcessingStatus("")
    }
  }, [onContent, onError, cancelPolling, startPolling])

  const buttonText = getButtonText(processingStatus, isLoading, uploadedFileName, label)
  const acceptAttribute = SUPPORTED_FILE_TYPES.join(',')

  return (
    <div className={className}>
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptAttribute}
        className="hidden"
        onChange={handleFileChange}
        aria-label="Upload Document"
      />
      <Button
        type="button"
        variant={uploadedFileName ? "secondary" : "outline"}
        size="sm"
        onClick={handleButtonClick}
        disabled={isLoading || disabled}
        className={`flex items-center gap-2 ${uploadedFileName ? 'border-green-500/50 text-green-700 dark:text-green-400' : ''}`}
        aria-label={label}
      >
        {isLoading ? (
          <Loader2 className="animate-spin h-4 w-4" />
        ) : uploadedFileName ? (
          <CheckCircle className="h-4 w-4 text-green-500" />
        ) : (
          <FileUp className="h-4 w-4" />
        )}
        {buttonText}
      </Button>
    </div>
  )
}