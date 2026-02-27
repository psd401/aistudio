"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { createPrompt } from "@/actions/prompt-library.actions"
import { useAction } from "@/lib/hooks/use-action"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { ArrowLeft, Save } from "lucide-react"
import { PageBranding } from "@/components/ui/page-branding"
import { useModels } from "@/lib/hooks/use-models"
import { PromptCreateForm } from "./prompt-create-form"
import type { SelectAiModel } from "@/types"
import type { PromptVisibility } from "@/lib/prompt-library/types"
import type { PromptLibrarySettings } from "@/lib/db/types/jsonb"
import { createPromptSchema } from "@/lib/prompt-library/validation"

interface NewPromptFormData {
  title: string
  content: string
  description: string
  visibility: PromptVisibility
  tags: string[]
}

export default function NewPromptPage() {
  const router = useRouter()
  const [formData, setFormData] = useState<NewPromptFormData>({
    title: '',
    content: '',
    description: '',
    visibility: 'private',
    tags: []
  })

  // Settings state
  const [selectedModel, setSelectedModel] = useState<SelectAiModel | null>(null)
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [enabledConnectors, setEnabledConnectors] = useState<string[]>([])

  const { models, isLoading: modelsLoading } = useModels()

  const { execute: executeCreate, isPending: isCreating } = useAction(createPrompt, {
    onSuccess: (data) => {
      toast.success("Prompt created successfully")
      router.push(`/prompt-library/${data.id}`)
    },
    onError: (error) => {
      toast.error(error)
    }
  })

  const handleModelChange = useCallback((model: SelectAiModel) => {
    setSelectedModel(model)
  }, [])

  const handleCreate = async () => {
    // Validate using Zod schema for consistency with server-side validation
    const validation = createPromptSchema.safeParse(formData)
    if (!validation.success) {
      const firstError = validation.error.issues[0]
      toast.error(firstError.message)
      return
    }

    // Build settings from current selections
    const settings: PromptLibrarySettings = {}
    if (selectedModel) settings.modelId = selectedModel.modelId
    if (enabledTools.length > 0) settings.tools = enabledTools
    if (enabledConnectors.length > 0) settings.connectors = enabledConnectors

    await executeCreate({
      title: formData.title,
      content: formData.content,
      description: formData.description || undefined,
      visibility: formData.visibility,
      tags: formData.tags,
      settings: Object.keys(settings).length > 0 ? settings : undefined
    })
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      {/* Header */}
      <div className="mb-6">
        <PageBranding />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push('/prompt-library')}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Create New Prompt</h1>
              <p className="text-sm text-muted-foreground">
                Add a new prompt to your library
              </p>
            </div>
          </div>

          <Button
            onClick={handleCreate}
            disabled={isCreating}
          >
            <Save className="mr-2 h-4 w-4" />
            {isCreating ? 'Creating...' : 'Create Prompt'}
          </Button>
        </div>
      </div>

      <PromptCreateForm
        formData={formData}
        onFormDataChange={setFormData}
        models={models}
        modelsLoading={modelsLoading}
        selectedModel={selectedModel}
        onModelChange={handleModelChange}
        enabledTools={enabledTools}
        onToolsChange={setEnabledTools}
        enabledConnectors={enabledConnectors}
        onConnectorsChange={setEnabledConnectors}
      />
    </div>
  )
}
