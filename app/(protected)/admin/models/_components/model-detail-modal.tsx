"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import type { SelectAiModel } from "@/types/db-types"
import {
  type CostErrors,
  type CostField,
  emptyFormData,
  type ModelFormData,
  modelToFormData,
} from "./model-detail-form"
import {
  AvailabilityPanel,
  ConfigurationPanel,
  CostSettings,
  IdentityPanel,
  ModelModalFooter,
  Separator,
} from "./model-detail-sections"
import { ProviderBadge } from "./provider-badge"

export type { ModelFormData } from "./model-detail-form"

interface ModelDetailModalProps {
  model: SelectAiModel | null
  isNew?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (data: ModelFormData) => Promise<void>
  onDelete?: (model: SelectAiModel) => void
}

interface ModelDetailStateOptions extends ModelDetailModalProps {
  isNew: boolean
}

function validateCost(value: string): string | undefined {
  if (!/^\d*\.?\d*$/.test(value)) return "Must be a valid number"

  const parsed = Number.parseFloat(value)
  if (Number.isNaN(parsed)) return "Must be a valid number"
  if (parsed < 0) return "Must be 0 or greater"
  if (parsed > 100) return "Must be 100 or less"
  return undefined
}

function requiredFieldError(formData: ModelFormData): string | undefined {
  if (!formData.name.trim()) return "Name is required"
  if (!formData.provider) return "Provider is required"
  if (!formData.modelId.trim()) return "Model ID is required"
  return undefined
}

function useModelDetailState({
  isNew,
  model,
  onOpenChange,
  onSave,
  open,
}: ModelDetailStateOptions) {
  const { toast } = useToast()
  const [formData, setFormData] = useState<ModelFormData>(emptyFormData)
  const [saving, setSaving] = useState(false)
  const [costOpen, setCostOpen] = useState(false)
  const [costErrors, setCostErrors] = useState<CostErrors>({})
  const firstInputRef = useRef<HTMLInputElement>(null)
  const triggerElementRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (model) {
      setFormData(modelToFormData(model))
    } else if (isNew) {
      setFormData(emptyFormData)
    }
  }, [model, isNew, open])

  useEffect(() => {
    if (open) {
      triggerElementRef.current = document.activeElement as HTMLElement
    } else {
      triggerElementRef.current?.focus()
    }
  }, [open])

  const updateField = useCallback(
    <K extends keyof ModelFormData>(field: K, value: ModelFormData[K]) => {
      setFormData((previous) => ({ ...previous, [field]: value }))
    },
    []
  )

  const handleCostChange = useCallback(
    (field: CostField) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value
      if (!value) {
        updateField(field, null)
        setCostErrors((previous) => ({ ...previous, [field]: undefined }))
        return
      }

      const error = validateCost(value)
      setCostErrors((previous) => ({ ...previous, [field]: error }))
      if (!error) updateField(field, value)
    },
    [updateField]
  )

  const copyId = useCallback(() => {
    if (!model?.id) return
    navigator.clipboard.writeText(model.id.toString())
    toast({ description: "ID copied to clipboard" })
  }, [model?.id, toast])

  const handleSave = useCallback(async () => {
    const validationError = requiredFieldError(formData)
    if (validationError) {
      toast({
        title: "Error",
        description: validationError,
        variant: "destructive",
      })
      return
    }

    setSaving(true)
    try {
      await onSave(formData)
      onOpenChange(false)
    } catch {
      // The parent owns the error toast; the server action owns error logging.
    } finally {
      setSaving(false)
    }
  }, [formData, onSave, onOpenChange, toast])

  return {
    copyId,
    costErrors,
    costOpen,
    firstInputRef,
    formData,
    handleCostChange,
    handleSave,
    saving,
    setCostOpen,
    updateField,
  }
}

export function ModelDetailModal({
  model,
  isNew = false,
  open,
  onOpenChange,
  onSave,
  onDelete,
}: ModelDetailModalProps) {
  const state = useModelDetailState({
    isNew,
    model,
    open,
    onDelete,
    onOpenChange,
    onSave,
  })
  const title = isNew ? "Add New Model" : `Edit ${model?.name || "Model"}`

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="rounded-lg border bg-background shadow-lg p-0 flex flex-col data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "min(95vw, 1600px)",
            maxWidth: "min(95vw, 1600px)",
            minWidth: "90vw",
            height: "90vh",
            maxHeight: "90vh",
            zIndex: 50,
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            state.firstInputRef.current?.focus()
          }}
        >
          <Dialog.Close className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <XIcon className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Dialog.Close>

          <div className="flex-shrink-0 px-6 pt-6 pb-4">
            <Dialog.Title className="text-xl font-semibold leading-none">
              {title}
            </Dialog.Title>
            {model && <ProviderBadge provider={state.formData.provider} />}
            <Dialog.Description className="sr-only">
              {isNew
                ? "Add a new AI model to the system"
                : "Edit AI model configuration"}
            </Dialog.Description>
          </div>

          <div className="flex-1 overflow-y-auto px-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 py-4">
              <IdentityPanel
                copyId={state.copyId}
                firstInputRef={state.firstInputRef}
                formData={state.formData}
                model={model}
                updateField={state.updateField}
              />
              <div className="space-y-6">
                <ConfigurationPanel
                  formData={state.formData}
                  isNew={isNew}
                  model={model}
                  updateField={state.updateField}
                />
                <Separator />
                <AvailabilityPanel
                  formData={state.formData}
                  updateField={state.updateField}
                />
                <Separator />
                <CostSettings
                  costErrors={state.costErrors}
                  costOpen={state.costOpen}
                  formData={state.formData}
                  handleCostChange={state.handleCostChange}
                  setCostOpen={state.setCostOpen}
                />
              </div>
            </div>
          </div>

          <ModelModalFooter
            handleSave={state.handleSave}
            isNew={isNew}
            model={model}
            onDelete={onDelete}
            onOpenChange={onOpenChange}
            saving={state.saving}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
