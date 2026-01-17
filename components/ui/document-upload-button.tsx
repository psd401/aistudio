"use client"

import { useRef, useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Loader2, FileUp, CheckCircle } from "lucide-react"
import { toast } from "sonner"
// Client-side logging helper
const logError = (message: string, data?: Record<string, unknown>) => {
  console.error(`[DocumentUploadButton] ${message}`, data)
}

interface DocumentUploadButtonProps {
  onContent: (content: string) => void
  label?: string
  className?: string
  disabled?: boolean
  onError?: (err: { status?: number; message?: string }) => void
}

// Supported file types based on Documents v2 implementation
const SUPPORTED_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/msword', // .doc
  'application/vnd.ms-excel', // .xls
  'application/vnd.ms-powerpoint', // .ppt
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-yaml',
  'text/yaml',
  'text/x-yaml',
]

// File size limit for assistant purpose (50MB)
const MAX_FILE_SIZE = 50 * 1024 * 1024

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
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  
  // Client-side component - using console for error tracking

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current)
        pollingTimeoutRef.current = null
      }
    }
  }, [])

  const handleButtonClick = () => {
    if (fileInputRef.current) fileInputRef.current.value = ""
    fileInputRef.current?.click()
  }

  const pollJobStatus = async (jobId: string, fileName: string, maxAttempts = 60) => {
    let attempts = 0;
    let pollInterval = 1000; // Start with 1 second
    
    const poll = async () => {
      try {
        if (attempts >= maxAttempts) {
          throw new Error('Processing timeout - document processing took too long');
        }

        const response = await fetch(`/api/documents/v2/jobs/${jobId}`);
        
        if (!response.ok) {
          throw new Error(`Failed to check job status: ${response.status}`);
        }
      
        const job = await response.json();
        
        if (job.status === 'completed') {
          // Stop polling - clear the timeout ref
          if (pollingTimeoutRef.current) {
            clearTimeout(pollingTimeoutRef.current)
            pollingTimeoutRef.current = null
          }
          
          // Process the result - match nexus adapter pattern
          const result = job.result;
          let extractedText = '';
          
          if (result && result.markdown) {
            extractedText = result.markdown;
          } else if (result && result.text) {
            extractedText = result.text;
          } else {
            throw new Error('No content extracted from document')
          }
          
          // Get file extension for tag
          const fileExt = fileName.split('.').pop()?.toLowerCase() || 'unknown'
          const docTag = `<document title="${fileName}" type="${fileExt}">\n${extractedText}\n</document>`
          onContent(docTag)
          setUploadedFileName(fileName)
          toast.success("Document content added to system context.")
          setIsLoading(false)
          setProcessingStatus("")
          
        } else if (job.status === 'failed') {
          // Stop polling - clear the timeout ref
          if (pollingTimeoutRef.current) {
            clearTimeout(pollingTimeoutRef.current)
            pollingTimeoutRef.current = null
          }
          
          const errorMessage = job.error || job.errorMessage || 'Document processing failed'
          throw new Error(errorMessage)
        } else if (job.status === 'processing') {
          // Show progress if available
          if (job.progress && job.processingStage) {
            setProcessingStatus(`Processing document... (${job.processingStage} - ${job.progress}%)`);
          } else {
            setProcessingStatus("Processing document...");
          }
          // Continue polling with exponential backoff and jitter
          const nextInterval = Math.min(pollInterval * 1.2, 5000); // Max 5 seconds
          const jitter = Math.random() * 0.2 + 0.9; // 90-110% of interval for jitter
          const jitteredInterval = nextInterval * jitter;
          
          pollingTimeoutRef.current = setTimeout(poll, jitteredInterval);
          pollInterval = nextInterval;
          attempts++;
        } else {
          // Unknown status, treat as still processing
          setProcessingStatus("Processing document...");
          const jitter = Math.random() * 0.2 + 0.9; // Add jitter for unknown status too
          pollingTimeoutRef.current = setTimeout(poll, pollInterval * jitter);
          attempts++;
        }
        
      } catch (error) {
        // Stop polling - clear the timeout ref
        if (pollingTimeoutRef.current) {
          clearTimeout(pollingTimeoutRef.current)
          pollingTimeoutRef.current = null
        }
        
        const errorMessage = error instanceof Error ? error.message : "Failed to process document."
        
        // Enhanced error logging with context
        logError('Polling error occurred', { 
          error: error instanceof Error ? error.message : String(error), 
          jobId, 
          fileName, 
          attempts,
          errorMessage
        });
        
        toast.error(errorMessage)
        
        // Enhanced error reporting with status code if available
        const status = error instanceof Error && error.message.includes('status:') 
          ? Number.parseInt(error.message.split('status:')[1]) 
          : undefined;
        onError?.({ message: errorMessage, status })
        
        setUploadedFileName(null)
        setIsLoading(false)
        setProcessingStatus("")
      }
    };
    
    // Start polling
    poll();
  }

  /**
   * Upload file via server-side endpoint to bypass school network restrictions.
   * School networks block direct S3 presigned URL uploads, but allow uploads
   * to aistudio.psd401.ai domain which then proxies to S3.
   *
   * @see https://github.com/psd401/aistudio/issues/632
   */
  const uploadViaServer = async (file: File): Promise<{ jobId: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('purpose', 'assistant');
    formData.append('processingOptions', JSON.stringify({
      extractText: true,
      convertToMarkdown: true,
      extractImages: false,
      generateEmbeddings: false,
      ocrEnabled: true
    }));

    const response = await fetch('/api/documents/v2/upload', {
      method: 'POST',
      body: formData, // No Content-Type header - browser sets it with boundary
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(errorData.error || `Upload failed: ${response.status}`);
    }

    const result = await response.json();

    if (!result.jobId) {
      throw new Error('Server upload response missing jobId');
    }

    return { jobId: result.jobId };
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
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

    // Cancel any existing polling before starting new upload
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current)
      pollingTimeoutRef.current = null
    }

    setIsLoading(true)
    setUploadedFileName(null)
    setProcessingStatus("Uploading...")

    try {
      // Use server-side upload to bypass school network restrictions on S3 presigned URLs
      // See: https://github.com/psd401/aistudio/issues/632
      const { jobId } = await uploadViaServer(file)

      setProcessingStatus("Processing document...")

      // Poll for job status
      pollJobStatus(jobId, file.name)
      
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to process document."
      
      // Error logging for client-side debugging
      logError('Upload error occurred', {
        error: err instanceof Error ? err.message : String(err),
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        errorMessage
      });
      
      toast.error(errorMessage)
      onError?.({ message: errorMessage })
      setUploadedFileName(null)
      setIsLoading(false)
      setProcessingStatus("")
    }
  }

  // Determine button text based on state
  const getButtonText = () => {
    if (processingStatus) return processingStatus
    if (isLoading) return "Processing..."
    if (uploadedFileName) return `✓ ${uploadedFileName.length > 20 ? uploadedFileName.substring(0, 20) + '...' : uploadedFileName}`
    return label || "Upload Document"
  }

  // Generate accept attribute for file input
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
        {getButtonText()}
      </Button>
    </div>
  )
}