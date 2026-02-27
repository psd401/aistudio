"use client"

import { useState, useEffect, useRef, startTransition } from "react"
import { useParams, useRouter } from "next/navigation"
import { useAction } from "@/lib/hooks/use-action"
import { getPrompt, updatePrompt, deletePrompt } from "@/actions/prompt-library.actions"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { ArrowLeft, Save, Trash2 } from "lucide-react"
import { PageBranding } from "@/components/ui/page-branding"
import { useModels } from "@/lib/hooks/use-models"
import { PromptEditForm } from "./prompt-edit-form"
import type { SelectAiModel } from "@/types"
import type { Prompt } from "@/lib/prompt-library/types"
import type { PromptLibrarySettings } from "@/lib/db/types/jsonb"

export default function PromptEditPage() {
  const params = useParams()
  const router = useRouter()
  const promptId = params.id as string

  const [formData, setFormData] = useState<Partial<Prompt>>({
    title: '', content: '', description: '', visibility: 'private', tags: []
  })
  const [loading, setLoading] = useState(true)
  const [promptData, setPromptData] = useState<Prompt | null>(null)
  const [selectedModel, setSelectedModel] = useState<SelectAiModel | null>(null)
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [enabledConnectors, setEnabledConnectors] = useState<string[]>([])
  const [isUpdating, setIsUpdating] = useState(false)

  const { models, isLoading: modelsLoading } = useModels()
  const { execute: executeGet } = useAction(getPrompt, { showSuccessToast: false, showErrorToast: false })
  const { execute: executeDelete, isPending: isDeleting } = useAction(deletePrompt)

  useEffect(() => {
    async function loadPrompt() {
      setLoading(true)
      const result = await executeGet(promptId)
      if (result?.isSuccess && result.data) {
        setPromptData(result.data)
        setFormData({
          title: result.data.title, content: result.data.content,
          description: result.data.description || '', visibility: result.data.visibility,
          tags: result.data.tags || []
        })
        if (result.data.settings) {
          setEnabledTools(result.data.settings.tools || [])
          setEnabledConnectors(result.data.settings.connectors || [])
        }
      }
      setLoading(false)
    }
    if (promptId) loadPrompt()
  }, [promptId]) // eslint-disable-line react-hooks/exhaustive-deps -- executeGet is stable (useAction returns stable ref)

  const modelInitialized = useRef(false)
  useEffect(() => {
    if (models.length === 0 || !promptData?.settings?.modelId || modelInitialized.current) return
    const match = models.find(m => m.modelId === promptData.settings?.modelId)
    if (match) {
      modelInitialized.current = true
      startTransition(() => { setSelectedModel(match) })
    }
  }, [models, promptData])

  const handleSave = async () => {
    if (!formData.title || !formData.content) { toast.error("Title and content are required"); return }
    const hasSettings = selectedModel || enabledTools.length > 0 || enabledConnectors.length > 0
    const settings: PromptLibrarySettings | null = hasSettings ? {
      ...(selectedModel ? { modelId: selectedModel.modelId } : {}),
      ...(enabledTools.length > 0 ? { tools: enabledTools } : {}),
      ...(enabledConnectors.length > 0 ? { connectors: enabledConnectors } : {}),
    } : null

    setIsUpdating(true)
    try {
      const result = await updatePrompt(promptId, {
        title: formData.title, content: formData.content,
        description: formData.description || undefined, visibility: formData.visibility,
        tags: formData.tags, settings
      })
      if (result?.isSuccess) {
        toast.success("Prompt updated successfully")
        if (result.data) setPromptData(result.data)
      } else {
        toast.error(result?.message || "Failed to update prompt")
      }
    } finally {
      setIsUpdating(false)
    }
  }

  const handleDelete = async () => {
    if (confirm("Are you sure you want to delete this prompt?")) {
      const result = await executeDelete(promptId)
      if (result?.isSuccess) { toast.success("Prompt deleted successfully"); router.push('/prompt-library') }
      else { toast.error(result?.message || "Failed to delete prompt") }
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    )
  }

  if (!promptData) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-destructive">Prompt not found</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6">
        <PageBranding />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => router.push('/prompt-library')}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Edit Prompt</h1>
              <p className="text-sm text-muted-foreground">Modify your prompt details and settings</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleDelete} disabled={isDeleting}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </Button>
            <Button onClick={handleSave} disabled={isUpdating}>
              <Save className="mr-2 h-4 w-4" /> {isUpdating ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </div>

      <PromptEditForm
        formData={formData} onFormDataChange={setFormData} promptData={promptData}
        models={models} modelsLoading={modelsLoading}
        selectedModel={selectedModel} onModelChange={setSelectedModel}
        enabledTools={enabledTools} onToolsChange={setEnabledTools}
        enabledConnectors={enabledConnectors} onConnectorsChange={setEnabledConnectors}
      />
    </div>
  )
}
