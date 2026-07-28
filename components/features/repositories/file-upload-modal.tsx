"use client"

import { useState } from "react"
import { useForm, type UseFormReturn } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAction } from "@/lib/hooks/use-action"
import {
  addDocumentWithPresignedUrl,
  addUrlItem,
  addTextItem,
  type AddDocumentWithPresignedUrlInput,
} from "@/actions/repositories/repository-items.actions"
import {
  Cloud,
  FileText,
  Link,
  Type,
  Upload,
  Loader2,
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  uploadFileToRepositoryStorage,
  type BrowserRepositoryUpload,
} from "@/lib/repositories/content-platform/browser-upload"
import { GoogleDriveConnectorPanel } from "./google-drive-connector-panel"

// File size limits - will be loaded from environment
const ACCEPTED_FILE_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
  "audio/amr",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-flac",
  "audio/x-m4a",
  "audio/x-wav",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
  "text/plain",
  "text/markdown",
  "text/csv",
]

const FILE_TYPE_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.amr': 'audio/amr',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
}

function contentTypeForFile(file: File): string {
  const declared = file.type.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  if (ACCEPTED_FILE_TYPES.includes(declared)) return declared
  const fileName = file.name.toLowerCase()
  const extension = Object.keys(FILE_TYPE_BY_EXTENSION).find((candidate) =>
    fileName.endsWith(candidate)
  )
  return extension ? FILE_TYPE_BY_EXTENSION[extension] : declared
}

// Helper function to validate file type
function isValidFileType(file: File): boolean {
  return ACCEPTED_FILE_TYPES.includes(contentTypeForFile(file))
}
const urlSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().url("Must be a valid URL"),
})

const textSchema = z.object({
  name: z.string().min(1, "Name is required"),
  content: z.string().min(1, "Content is required"),
})

interface FileUploadModalProps {
  repositoryId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

type AddDocumentExecution = (
  input: AddDocumentWithPresignedUrlInput
) => ReturnType<typeof addDocumentWithPresignedUrl>

async function uploadRepositoryDocument(options: {
  repositoryId: number
  itemName: string
  file: File
  contentType: string
  executeLegacyUpload: AddDocumentExecution
}) {
  const {
    repositoryId,
    itemName,
    file,
    contentType,
    executeLegacyUpload,
  } = options
  const canonicalResponse = await fetch(
    `/api/repositories/${repositoryId}/uploads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itemName,
        fileName: file.name,
        contentType,
        byteSize: file.size,
      }),
    }
  )
  if (!canonicalResponse.ok) {
    const error = await canonicalResponse.json()
    throw new Error(error.error || "Failed to initiate upload")
  }
  const canonical = await canonicalResponse.json()
  if (canonical.mode === "canonical") {
    const upload = canonical.upload as BrowserRepositoryUpload
    const completedParts = await uploadFileToRepositoryStorage(
      file,
      upload,
      contentType
    )
    const completionResponse = await fetch(
      `/api/repositories/${repositoryId}/uploads/${upload.sessionId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts:
            upload.uploadMethod === "multipart" ? completedParts : undefined,
        }),
      }
    )
    if (!completionResponse.ok) {
      const error = await completionResponse.json()
      throw new Error(error.error || "Failed to complete upload")
    }
    return { isSuccess: true, message: "File uploaded successfully" }
  }

  const presignedResponse = await fetch("/api/documents/presigned-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      fileType: contentType,
      fileSize: file.size,
      repositoryId,
    }),
  })
  if (!presignedResponse.ok) {
    const error = await presignedResponse.json()
    throw new Error(error.error || "Failed to get upload URL")
  }
  const response = await presignedResponse.json()
  const { url, key } = response.data || response
  const uploadResponse = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  })
  if (!uploadResponse.ok) {
    throw new Error("Failed to upload file to storage")
  }
  return executeLegacyUpload({
    repository_id: repositoryId,
    name: itemName,
    s3Key: key,
    metadata: {
      contentType,
      size: file.size,
      originalFileName: file.name,
    },
  })
}

type DocumentValues = {
  name: string
  file: FileList
}
type UrlValues = z.infer<typeof urlSchema>
type TextValues = z.infer<typeof textSchema>

interface DocumentUploadTabProps {
  documentForm: UseFormReturn<DocumentValues>
  onDocumentSubmit: (data: DocumentValues) => Promise<void>
  isDocumentUploadPending: boolean
  isLoading: boolean
  isAddingDocument: boolean
  maxFileSizeGB: number
  onClose: () => void
}

function DocumentUploadTab({
  documentForm,
  onDocumentSubmit,
  isDocumentUploadPending,
  isLoading,
  isAddingDocument,
  maxFileSizeGB,
  onClose,
}: DocumentUploadTabProps) {
  return (
          <TabsContent value="document">
            <Form {...documentForm}>
              <form
                onSubmit={documentForm.handleSubmit(onDocumentSubmit)}
                className="space-y-4"
              >
                <FormField
                  control={documentForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="e.g., User Manual"
                          disabled={isDocumentUploadPending}
                        />
                      </FormControl>
                      <FormDescription>
                        A descriptive name for the document
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={documentForm.control}
                  name="file"
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  render={({ field: { onChange, value, ...field } }) => (
                    <FormItem>
                      <FormLabel>File</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={undefined}
                          type="file"
                          disabled={isDocumentUploadPending}
                          accept=".pdf,.docx,.xlsx,.pptx,.jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,.amr,.flac,.m4a,.mp3,.ogg,.wav,.mp4,.mov,.avi,.mkv,.webm,.txt,.md,.csv"
                          onChange={(e) => onChange(e.target.files)}
                        />
                      </FormControl>
                      <FormDescription>
                        Supported: PDF, Word, Excel, PowerPoint, JPEG, PNG,
                        WebP, GIF, TIFF, MP3, M4A, WAV, FLAC, Ogg, AMR, MP4,
                        MOV, AVI, MKV, WebM, Text, Markdown, CSV (max server
                        policy; browser ceiling {maxFileSizeGB} GB)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onClose}
                    disabled={isDocumentUploadPending}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isLoading}>
                    {isAddingDocument && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    <Upload className="mr-2 h-4 w-4" />
                    Upload File
                  </Button>
                </div>
              </form>
            </Form>
          </TabsContent>
  )
}

interface UrlUploadTabProps {
  urlForm: UseFormReturn<UrlValues>
  onUrlSubmit: (data: UrlValues) => Promise<void>
  isLoading: boolean
  isAddingUrl: boolean
  onClose: () => void
}

function UrlUploadTab({
  urlForm,
  onUrlSubmit,
  isLoading,
  isAddingUrl,
  onClose,
}: UrlUploadTabProps) {
  return (
          <TabsContent value="url">
            <Form {...urlForm}>
              <form
                onSubmit={urlForm.handleSubmit(onUrlSubmit)}
                className="space-y-4"
              >
                <FormField
                  control={urlForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="e.g., API Documentation"
                        />
                      </FormControl>
                      <FormDescription>
                        A descriptive name for the URL content
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={urlForm.control}
                  name="url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>URL</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="url"
                          placeholder="https://example.com/docs"
                        />
                      </FormControl>
                      <FormDescription>
                        The URL to fetch content from
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onClose}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isLoading}>
                    {isAddingUrl && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Add URL
                  </Button>
                </div>
              </form>
            </Form>
          </TabsContent>
  )
}

interface TextUploadTabProps {
  textForm: UseFormReturn<TextValues>
  onTextSubmit: (data: TextValues) => Promise<void>
  isLoading: boolean
  isAddingText: boolean
  onClose: () => void
}

function TextUploadTab({
  textForm,
  onTextSubmit,
  isLoading,
  isAddingText,
  onClose,
}: TextUploadTabProps) {
  return (
          <TabsContent value="text">
            <Form {...textForm}>
              <form
                onSubmit={textForm.handleSubmit(onTextSubmit)}
                className="space-y-4"
              >
                <FormField
                  control={textForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g., Quick Reference" />
                      </FormControl>
                      <FormDescription>
                        A descriptive name for the text content
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={textForm.control}
                  name="content"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Content</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder="Enter your text content here..."
                          rows={6}
                        />
                      </FormControl>
                      <FormDescription>
                        The text content to add to the repository
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onClose}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isLoading}>
                    {isAddingText && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Add Text
                  </Button>
                </div>
              </form>
            </Form>
          </TabsContent>
  )
}

function GoogleDriveUploadTab({
  repositoryId,
  onSuccess,
  onClose,
}: {
  repositoryId: number
  onSuccess: () => void
  onClose: () => void
}) {
  return (
          <TabsContent value="google-drive">
            <GoogleDriveConnectorPanel
              repositoryId={repositoryId}
              onSourcesChanged={onSuccess}
            />
            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
              >
                Close
              </Button>
            </div>
          </TabsContent>
  )
}

function useDocumentUpload(
  repositoryId: number,
  onOpenChange: (open: boolean) => void,
  onSuccess: () => void
) {
  const { toast } = useToast()
  const [isDocumentUploadPending, setIsDocumentUploadPending] = useState(false)
  const maxFileSizeGB = 50
  const maxFileSize = maxFileSizeGB * 1024 * 1024 * 1024
  const documentSchema = z.object({
    name: z.string().min(1, "Name is required"),
    file: z
      .custom<FileList>()
      .refine((files) => files?.length === 1, "File is required")
      .refine(
        (files) => Boolean(files?.[0] && files[0].size <= maxFileSize),
        `File size must be less than ${maxFileSizeGB} GB`
      )
      .refine(
        (files) => Boolean(files?.[0] && isValidFileType(files[0])),
        "File type not supported"
      ),
  })
  const documentForm = useForm<DocumentValues>({
    resolver: zodResolver(documentSchema),
    defaultValues: { name: "" },
  })
  const { execute: executeLegacyUpload, isPending: isAddingDocumentAction } =
    useAction(addDocumentWithPresignedUrl)
  const isAddingDocument =
    isDocumentUploadPending || isAddingDocumentAction

  async function onDocumentSubmit(data: DocumentValues) {
    if (isDocumentUploadPending) return
    const file = data.file[0]
    setIsDocumentUploadPending(true)
    try {
      const result = await uploadRepositoryDocument({
        repositoryId,
        itemName: data.name,
        file,
        contentType: contentTypeForFile(file),
        executeLegacyUpload,
      })
      if (result.isSuccess) {
        toast({
          title: "File uploaded",
          description: "The file has been added to the repository.",
        })
        documentForm.reset()
        onSuccess()
        onOpenChange(false)
      } else {
        toast({
          title: "Error",
          description: result.message || "Failed to upload document",
          variant: "destructive",
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to upload document",
        variant: "destructive",
      })
    } finally {
      setIsDocumentUploadPending(false)
    }
  }

  return {
    documentForm,
    isDocumentUploadPending,
    isAddingDocument,
    maxFileSizeGB,
    onDocumentSubmit,
  }
}

export function FileUploadModal({
  repositoryId,
  open,
  onOpenChange,
  onSuccess,
}: FileUploadModalProps) {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState("document")
  const {
    documentForm,
    isDocumentUploadPending,
    isAddingDocument,
    maxFileSizeGB,
    onDocumentSubmit,
  } = useDocumentUpload(repositoryId, onOpenChange, onSuccess)
  const urlForm = useForm<z.infer<typeof urlSchema>>({
    resolver: zodResolver(urlSchema),
    defaultValues: {
      name: "",
      url: "",
    },
  })

  const textForm = useForm<z.infer<typeof textSchema>>({
    resolver: zodResolver(textSchema),
    defaultValues: {
      name: "",
      content: "",
    },
  })

  const { execute: executeAddUrl, isPending: isAddingUrl } =
    useAction(addUrlItem)
  const { execute: executeAddText, isPending: isAddingText } =
    useAction(addTextItem)

  const isLoading = isAddingDocument || isAddingUrl || isAddingText

  async function onUrlSubmit(data: z.infer<typeof urlSchema>) {
    const result = await executeAddUrl({
      repository_id: repositoryId,
      name: data.name,
      url: data.url,
    })

    if (result.isSuccess) {
      toast({
        title: "URL added",
        description: "The URL has been added to the repository.",
      })
      urlForm.reset()
      onSuccess()
      onOpenChange(false)
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to add URL",
        variant: "destructive",
      })
    }
  }

  async function onTextSubmit(data: z.infer<typeof textSchema>) {
    const result = await executeAddText({
      repository_id: repositoryId,
      name: data.name,
      content: data.content,
    })

    if (result.isSuccess) {
      toast({
        title: "Text added",
        description: "The text has been added to the repository.",
      })
      textForm.reset()
      onSuccess()
      onOpenChange(false)
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to add text",
        variant: "destructive",
      })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isDocumentUploadPending) return
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Add Item to Repository</DialogTitle>
          <DialogDescription>
            Add files, URLs, or text content to your knowledge repository.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4">
            <TabsTrigger value="document" disabled={isDocumentUploadPending}>
              <FileText className="mr-2 h-4 w-4" />
              File
            </TabsTrigger>
            <TabsTrigger value="url" disabled={isDocumentUploadPending}>
              <Link className="mr-2 h-4 w-4" />
              URL
            </TabsTrigger>
            <TabsTrigger value="text" disabled={isDocumentUploadPending}>
              <Type className="mr-2 h-4 w-4" />
              Text
            </TabsTrigger>
            <TabsTrigger value="google-drive" disabled={isDocumentUploadPending}>
              <Cloud className="mr-2 h-4 w-4" />
              Google Drive
            </TabsTrigger>
          </TabsList>

          <DocumentUploadTab
            documentForm={documentForm}
            onDocumentSubmit={onDocumentSubmit}
            isDocumentUploadPending={isDocumentUploadPending}
            isLoading={isLoading}
            isAddingDocument={isAddingDocument}
            maxFileSizeGB={maxFileSizeGB}
            onClose={() => onOpenChange(false)}
          />

          <UrlUploadTab
            urlForm={urlForm}
            onUrlSubmit={onUrlSubmit}
            isLoading={isLoading}
            isAddingUrl={isAddingUrl}
            onClose={() => onOpenChange(false)}
          />

          <TextUploadTab
            textForm={textForm}
            onTextSubmit={onTextSubmit}
            isLoading={isLoading}
            isAddingText={isAddingText}
            onClose={() => onOpenChange(false)}
          />

          <GoogleDriveUploadTab
            repositoryId={repositoryId}
            onSuccess={onSuccess}
            onClose={() => onOpenChange(false)}
          />
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
