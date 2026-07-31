"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Download, Loader2 } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { meridianPortalClassName } from "@/lib/meridian/fonts"

interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedAssistantIds: string[]
  assistants: Array<{
    id: string
    name: string
    description?: string
    status: string
  }>
  onExportComplete?: () => void
}

export function ExportDialog({
  open,
  onOpenChange,
  selectedAssistantIds,
  assistants,
  onExportComplete
}: ExportDialogProps) {
  const [isExporting, setIsExporting] = useState(false)
  const { toast } = useToast()

  const selectedAssistants = assistants.filter(a => selectedAssistantIds.includes(a.id))

  const handleExport = async () => {
    setIsExporting(true)

    try {
      const response = await fetch("/api/admin/assistants/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assistantIds: selectedAssistantIds,
        }),
      })

      if (response.ok) {
        // Get the filename from the Content-Disposition header
        const contentDisposition = response.headers.get("Content-Disposition")
        const filenameMatch = contentDisposition?.match(/filename="(.+)"/)
        const filename = filenameMatch ? filenameMatch[1] : "assistants-export.json"

        // Download the file
        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        window.URL.revokeObjectURL(url)

        toast({
          title: "Export successful",
          description: `Exported ${selectedAssistants.length} assistant(s)`,
        })

        onOpenChange(false)
        onExportComplete?.()
      } else {
        const error = await response.json()
        throw new Error(error.message || "Export failed")
      }
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "An error occurred during export",
        variant: "destructive",
      })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={meridianPortalClassName}>
        <DialogHeader>
          <DialogTitle>Export Assistants</DialogTitle>
          <DialogDescription>
            Export selected assistants to share with others or backup your configurations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <Alert>
            <AlertDescription>
              <strong>{selectedAssistants.length}</strong> assistant(s) selected for export:
            </AlertDescription>
          </Alert>

          <div className="max-h-[200px] overflow-y-auto space-y-2">
            {selectedAssistants.map((assistant) => (
              <div
                key={assistant.id}
                className="flex items-start gap-2 p-2 rounded border"
              >
                <div className="flex-1">
                  <div className="font-medium">{assistant.name}</div>
                  {assistant.description && (
                    <div className="text-sm text-muted-foreground line-clamp-1">
                      {assistant.description}
                    </div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {assistant.status}
                </div>
              </div>
            ))}
          </div>

          <Alert>
            <AlertDescription>
              The export will include all prompts and input fields for each assistant.
              User information and timestamps will be excluded for privacy.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isExporting}
          >
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isExporting}>
            {isExporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Export
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}