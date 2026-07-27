"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Upload, Loader2, FileText, AlertCircle, CheckCircle } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { ExportFormat } from "@/lib/assistant-export-import"

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImportComplete: () => void
}

interface ImportResult {
  name: string
  id?: string
  status: 'success' | 'error'
  error?: string
}

function ImportDropZone({
  dragActive,
  onDrag,
  onDrop,
  onFileInput,
}: {
  dragActive: boolean
  onDrag: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
  onFileInput: (event: React.ChangeEvent<HTMLInputElement>) => void
}) {
  const openFilePicker = () => document.getElementById("file-upload")?.click()
  return (
    <div
      className={`cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors duration-200 ${
        dragActive
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/50"
      }`}
      onDragEnter={onDrag}
      onDragLeave={onDrag}
      onDragOver={onDrag}
      onDrop={onDrop}
      onClick={openFilePicker}
      onKeyDown={(event) => event.key === "Enter" && openFilePicker()}
      role="button"
      tabIndex={0}
    >
      <Upload className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
      <p className="mb-1 text-sm font-medium">
        Drop your JSON file here or click to browse
      </p>
      <p className="text-xs text-muted-foreground">
        Maximum file size: 10MB
      </p>
      <input
        id="file-upload"
        type="file"
        accept=".json"
        onChange={onFileInput}
        className="hidden"
      />
    </div>
  )
}

function ImportPreview({
  file,
  data,
}: {
  file: File
  data: ExportFormat
}) {
  return (
    <>
      <Alert>
        <FileText className="h-4 w-4" />
        <AlertDescription>
          <strong>{file.name}</strong> ({(file.size / 1024).toFixed(2)} KB)
          <br />
          Version: {data.version} | Exported:{" "}
          {new Date(data.exported_at).toLocaleDateString()}
          {data.export_source && ` | Source: ${data.export_source}`}
        </AlertDescription>
      </Alert>
      <div>
        <h4 className="mb-2 text-sm font-medium">
          Assistants to import ({data.assistants.length}):
        </h4>
        <ScrollArea className="h-[200px] w-full rounded border">
          <div className="space-y-2 p-2">
            {data.assistants.map((assistant, index) => (
              <div
                key={index}
                className="flex items-start gap-2 rounded p-2 hover:bg-muted/50"
              >
                <div className="flex-1">
                  <div className="font-medium">{assistant.name}</div>
                  {assistant.description && (
                    <div className="line-clamp-1 text-sm text-muted-foreground">
                      {assistant.description}
                    </div>
                  )}
                  <div className="mt-1 text-xs text-muted-foreground">
                    {assistant.prompts.length} prompts,{" "}
                    {assistant.input_fields.length} fields
                  </div>
                </div>
                <Badge variant="outline" className="text-xs">
                  {assistant.status}
                </Badge>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          All imported assistants will be set to{" "}
          <strong>pending approval</strong> status and assigned to your account.
          Models will be mapped to available options.
        </AlertDescription>
      </Alert>
    </>
  )
}

function ImportResults({ results }: { results: ImportResult[] }) {
  return (
    <div>
      <h4 className="mb-2 text-sm font-medium">Import Results:</h4>
      <ScrollArea className="h-[200px] w-full rounded border">
        <div className="space-y-2 p-2">
          {results.map((result, index) => (
            <div key={index} className="flex items-center gap-2 rounded p-2">
              {result.status === "success" ? (
                <CheckCircle className="h-4 w-4 text-green-500" />
              ) : (
                <AlertCircle className="h-4 w-4 text-destructive" />
              )}
              <div className="flex-1">
                <div className="font-medium">{result.name}</div>
                {result.error && (
                  <div className="text-xs text-destructive">{result.error}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function ImportFooter({
  file,
  results,
  isImporting,
  onSecondary,
  onImport,
}: {
  file: File | null
  results: ImportResult[] | null
  isImporting: boolean
  onSecondary: () => void
  onImport: () => void
}) {
  return (
    <DialogFooter>
      <Button
        variant="outline"
        onClick={onSecondary}
        disabled={isImporting}
      >
        {results ? "Import Another" : file ? "Change File" : "Cancel"}
      </Button>
      {file && !results && (
        <Button onClick={onImport} disabled={isImporting}>
          {isImporting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Importing...
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              Import
            </>
          )}
        </Button>
      )}
    </DialogFooter>
  )
}

function ImportDialogView({
  open,
  file,
  previewData,
  importResults,
  dragActive,
  isImporting,
  onOpenChange,
  onDrag,
  onDrop,
  onFileInput,
  onSecondary,
  onImport,
}: {
  open: boolean
  file: File | null
  previewData: ExportFormat | null
  importResults: ImportResult[] | null
  dragActive: boolean
  isImporting: boolean
  onOpenChange: (open: boolean) => void
  onDrag: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
  onFileInput: (event: React.ChangeEvent<HTMLInputElement>) => void
  onSecondary: () => void
  onImport: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Assistants</DialogTitle>
          <DialogDescription>
            Import assistants from a previously exported JSON file.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {!file && !importResults && (
            <ImportDropZone
              dragActive={dragActive}
              onDrag={onDrag}
              onDrop={onDrop}
              onFileInput={onFileInput}
            />
          )}
          {file && previewData && !importResults && (
            <ImportPreview file={file} data={previewData} />
          )}
          {importResults && <ImportResults results={importResults} />}
        </div>
        <ImportFooter
          file={file}
          results={importResults}
          isImporting={isImporting}
          onSecondary={onSecondary}
          onImport={onImport}
        />
      </DialogContent>
    </Dialog>
  )
}

export function ImportDialog({
  open,
  onOpenChange,
  onImportComplete
}: ImportDialogProps) {
  const [isImporting, setIsImporting] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [previewData, setPreviewData] = useState<ExportFormat | null>(null)
  const [importResults, setImportResults] = useState<ImportResult[] | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const { toast } = useToast()
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleFile = useCallback(async (selectedFile: File) => {
    // Reset states
    setImportResults(null)
    setPreviewData(null)

    // Validate file type
    if (!selectedFile.name.endsWith('.json')) {
      toast({
        title: "Invalid file type",
        description: "Please select a JSON file",
        variant: "destructive",
      })
      return
    }

    // Validate file size (10MB limit)
    if (selectedFile.size > 10 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Maximum file size is 10MB",
        variant: "destructive",
      })
      return
    }

    setFile(selectedFile)

    // Read and preview file
    try {
      const text = await selectedFile.text()
      const data = JSON.parse(text) as ExportFormat
      setPreviewData(data)
    } catch {
      toast({
        title: "Invalid file",
        description: "Could not parse JSON file",
        variant: "destructive",
      })
      setFile(null)
    }
  }, [toast])

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true)
    } else if (e.type === "dragleave") {
      setDragActive(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0])
    }
  }, [handleFile])

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0])
    }
  }


  const handleImport = async () => {
    if (!file) return

    setIsImporting(true)

    try {
      const formData = new FormData()
      formData.append("file", file)

      const response = await fetch("/api/admin/assistants/import", {
        method: "POST",
        body: formData,
      })

      const result = await response.json()

      if (response.ok && result.isSuccess) {
        setImportResults(result.data.results)
        
        toast({
          title: "Import complete",
          description: result.message,
        })

        // Refresh the table after successful import
        if (result.data.successful > 0) {
          timeoutRef.current = setTimeout(() => {
            onImportComplete()
            // Reset dialog state before closing
            resetDialog()
            onOpenChange(false)
          }, 2000)
        }
      } else {
        throw new Error(result.message || "Import failed")
      }
    } catch (error) {
      toast({
        title: "Import failed",
        description: error instanceof Error ? error.message : "An error occurred during import",
        variant: "destructive",
      })
    } finally {
      setIsImporting(false)
    }
  }

  const resetDialog = () => {
    setFile(null)
    setPreviewData(null)
    setImportResults(null)
    setDragActive(false)
    setIsImporting(false)
  }

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return (
    <ImportDialogView
      open={open}
      file={file}
      previewData={previewData}
      importResults={importResults}
      dragActive={dragActive}
      isImporting={isImporting}
      onOpenChange={(newOpen) => {
        onOpenChange(newOpen)
        if (!newOpen) resetDialog()
      }}
      onDrag={handleDrag}
      onDrop={handleDrop}
      onFileInput={handleFileInput}
      onSecondary={() => {
        if (importResults) {
          resetDialog()
        } else if (file) {
          setFile(null)
          setPreviewData(null)
        } else {
          onOpenChange(false)
        }
      }}
      onImport={handleImport}
    />
  )
}
