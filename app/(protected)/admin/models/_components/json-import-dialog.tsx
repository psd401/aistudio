"use client"

import { useState, useCallback } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { XIcon, Upload, Loader2, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/components/ui/use-toast"
import { validateModel } from "@/lib/validators/model-import-validator"

// JSON input schema for validation
interface ModelJsonInput {
  name: string
  modelId: string
  provider: string
  description?: string
  capabilities?: string[]
  maxTokens?: number
  active?: boolean
  nexusEnabled?: boolean
  architectEnabled?: boolean
  allowedRoles?: string[]
  inputCostPer1kTokens?: string
  outputCostPer1kTokens?: string
  cachedInputCostPer1kTokens?: string
}

interface ImportResult {
  created: number
  updated: number
  errors: string[]
}

interface JsonImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImportComplete: () => void
}

export function JsonImportDialog({
  open,
  onOpenChange,
  onImportComplete,
}: JsonImportDialogProps) {
  const { toast } = useToast()
  const [jsonInput, setJsonInput] = useState("")
  const [errors, setErrors] = useState<string[]>([])
  const [importing, setImporting] = useState(false)

  // Parse and validate JSON input
  const parseAndValidate = useCallback(
    (input: string): { models: ModelJsonInput[] | null; errors: string[] } => {
      const validationErrors: string[] = []

      if (!input.trim()) {
        return { models: null, errors: ["JSON input is empty"] }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(input)
      } catch (e) {
        return {
          models: null,
          errors: [`Invalid JSON: ${e instanceof Error ? e.message : "Parse error"}`],
        }
      }

      // Normalize to array
      const modelsArray = Array.isArray(parsed) ? parsed : [parsed]

      if (modelsArray.length === 0) {
        return { models: null, errors: ["No models found in JSON"] }
      }

      if (modelsArray.length > 100) {
        return { models: null, errors: ["Maximum 100 models per import"] }
      }

      // Validate each model
      for (let i = 0; i < modelsArray.length; i++) {
        const result = validateModel(modelsArray[i], i)
        if (!result.valid) {
          validationErrors.push(...result.errors)
        }
      }

      if (validationErrors.length > 0) {
        return { models: null, errors: validationErrors }
      }

      return { models: modelsArray as ModelJsonInput[], errors: [] }
    },
    []
  )

  // Handle import
  const handleImport = useCallback(async () => {
    // Parse and validate
    const { models, errors: validationErrors } = parseAndValidate(jsonInput)

    if (validationErrors.length > 0 || !models) {
      setErrors(validationErrors)
      return
    }

    setErrors([])
    setImporting(true)

    try {
      const response = await fetch("/api/admin/models/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models }),
      })

      const data = await response.json()

      if (!response.ok || !data.isSuccess) {
        if (data.errors && Array.isArray(data.errors)) {
          setErrors(data.errors)
        } else {
          setErrors([data.message || "Import failed"])
        }
        return
      }

      const result: ImportResult = data.data

      // Show success toast
      toast({
        title: "Import Successful",
        description: `Created: ${result.created}, Updated: ${result.updated}`,
      })

      // Reset and close
      setJsonInput("")
      setErrors([])
      onOpenChange(false)
      onImportComplete()
    } catch (error) {
      setErrors([
        error instanceof Error ? error.message : "Network error during import",
      ])
    } finally {
      setImporting(false)
    }
  }, [jsonInput, parseAndValidate, onOpenChange, onImportComplete, toast])

  // Handle close - reset state
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        setJsonInput("")
        setErrors([])
      }
      onOpenChange(newOpen)
    },
    [onOpenChange]
  )

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-0 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200"
        >
          {/* Close button */}
          <Dialog.Close className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
            <XIcon className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Dialog.Close>

          {/* Header */}
          <div className="px-6 pt-6 pb-4">
            <Dialog.Title className="text-lg font-semibold leading-none">
              Import AI Models from JSON
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              Paste JSON to create or update models. Existing models (by modelId) will be
              updated; new models will be created.
            </Dialog.Description>
          </div>

          {/* Content */}
          <div className="px-6 space-y-4">
            <Textarea
              rows={15}
              className="font-mono text-sm"
              placeholder={`Paste JSON here. Supports single object or array:

{
  "name": "GPT-4 Turbo",
  "modelId": "gpt-4-turbo",
  "provider": "openai",
  "description": "Latest GPT-4 model",
  "maxTokens": 128000,
  "active": true,
  "nexusEnabled": true,
  "architectEnabled": true,
  "inputCostPer1kTokens": "0.01",
  "outputCostPer1kTokens": "0.03"
}

Or array: [{ ... }, { ... }]`}
              value={jsonInput}
              onChange={(e) => {
                setJsonInput(e.target.value)
                setErrors([]) // Clear errors on input change
              }}
              disabled={importing}
            />

            {errors.length > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <ul className="list-disc pl-4 space-y-1">
                    {errors.slice(0, 10).map((error, i) => (
                      <li key={i} className="text-sm">
                        {error}
                      </li>
                    ))}
                    {errors.length > 10 && (
                      <li className="text-sm text-muted-foreground">
                        ...and {errors.length - 10} more errors
                      </li>
                    )}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <div className="text-xs text-muted-foreground">
              <strong>Required fields:</strong> name, modelId, provider (openai, azure,
              amazon-bedrock, google, google-vertex)
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 border-t mt-4 px-6 py-4">
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button
              onClick={handleImport}
              disabled={importing || !jsonInput.trim()}
            >
              {importing ? (
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
