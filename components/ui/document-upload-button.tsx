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

  const uploadToS3 = async (file: File, session: { uploadMethod?: string; uploadUrl?: string; partUrls?: { uploadUrl: string }[]; uploadId?: string; jobId?: string }) => {
    if (session.uploadMethod === 'multipart' && session.partUrls && session.uploadId && session.jobId) {
      // Handle multipart upload for very large files
      await multipartUpload(file, { partUrls: session.partUrls, uploadId: session.uploadId, jobId: session.jobId });
    } else if (session.uploadUrl) {
      // Direct upload for medium files
      const response = await fetch(session.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type
        }
      });
      
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
      }
    } else {
      throw new Error('Invalid session: missing uploadUrl for direct upload or required multipart data');
    }
  }

  const multipartUpload = async (file: File, session: { partUrls: { uploadUrl: string }[]; uploadId: string; jobId: string }) => {
    const partSize = 5 * 1024 * 1024; // 5MB chunks
    const parts = [];
    
    for (let i = 0; i < session.partUrls.length; i++) {
      const start = i * partSize;
      const end = Math.min(start + partSize, file.size);
      const chunk = file.slice(start, end);
      
      const response = await fetch(session.partUrls[i].uploadUrl, {
        method: 'PUT',
        body: chunk
      });
      
      if (!response.ok) {
        throw new Error(`Part upload failed: ${response.status}`);
      }
      
      parts.push({
        ETag: response.headers.get('ETag')?.replace(/"/g, ''),
        PartNumber: i + 1
      });
    }
    
    // Complete multipart upload
    const completeResponse = await fetch('/api/documents/v2/complete-multipart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: session.uploadId,
        jobId: session.jobId,
        parts
      })
    });
    
    if (!completeResponse.ok) {
      throw new Error('Failed to complete multipart upload');
    }
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
    setProcessingStatus("Preparing upload...")
    
    try {
      // Step 1: Initiate upload
      const initiateResponse = await fetch("/api/documents/v2/initiate-upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          purpose: 'assistant',
          processingOptions: {
            extractText: true,
            convertToMarkdown: true,
            extractImages: false, // Keep false for text focus
            generateEmbeddings: false, // Not needed for direct context
            ocrEnabled: true // Enable for scanned documents
          }
        }),
      })

      if (!initiateResponse.ok) {
        const errorData = await initiateResponse.json().catch(() => ({}))
        throw new Error(errorData.error || `Failed to initiate upload: ${initiateResponse.status}`)
      }

      const initiateData = await initiateResponse.json()
      const { jobId, uploadId } = initiateData

      setProcessingStatus("Uploading...")

      // Step 2: Upload file to S3
      await uploadToS3(file, initiateData)

      setProcessingStatus("Confirming upload...")

      // Step 3: Confirm upload
      const confirmResponse = await fetch("/api/documents/v2/confirm-upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jobId,
          uploadId,
        }),
      })

      if (!confirmResponse.ok) {
        const errorData = await confirmResponse.json().catch(() => ({}))
        throw new Error(errorData.error || `Failed to confirm upload: ${confirmResponse.status}`)
      }

      setProcessingStatus("Processing document...")

      // Step 4: Start polling for job status
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