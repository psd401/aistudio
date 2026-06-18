"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Button } from "@/components/ui/button"
import { Form } from "@/components/ui/form"
import {
  createAssistantArchitectAction,
  updateAssistantArchitectAction,
  addToolInputFieldAction,
  updateInputFieldAction,
  deleteInputFieldAction
} from "@/actions/db/assistant-architect-actions"
import { useToast } from "@/components/ui/use-toast"
import type { SelectAssistantArchitect, SelectToolInputField } from "@/types"
import { AssistantDetailsForm } from "./assistant-details-form"
import { InputFieldsSection } from "./input-fields-section"
import type { InputFieldData } from "./input-field-editor"
import { AgenticModeSection, type AgenticConfigState } from "./agentic-mode-section"

interface CreateFormProps {
  initialData?: SelectAssistantArchitect
  initialInputFields?: SelectToolInputField[]
}

const formSchema = z.object({
  name: z.string().min(3, { message: "Name must be at least 3 characters." }),
  description: z.string().optional(),
  imagePath: z.string().min(1, { message: "Please select an image for your assistant." }),
})

type FormValues = z.infer<typeof formSchema>

/**
 * Map the UI agentic config to the server-action payload. Cost cap is whole
 * dollars in the UI; the action/DB store whole cents. Tools are cleared when not
 * in agentic mode so a mode flip doesn't leave a stale tool list.
 */
function toAgenticPayload(agentic: AgenticConfigState) {
  return {
    mode: agentic.mode,
    agentEnabledTools: agentic.mode === "agentic" ? agentic.enabledTools : [],
    agentMaxSteps: agentic.maxSteps,
    agentTimeoutSeconds: agentic.timeoutSeconds,
    agentCostCapCents:
      agentic.costCapDollars === null ? null : Math.round(agentic.costCapDollars * 100),
  }
}

export function CreateForm({ initialData, initialInputFields = [] }: CreateFormProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [images, setImages] = useState<string[]>([])
  const [assistantId, setAssistantId] = useState<string | null>(
    initialData?.id ? String(initialData.id) : null
  )
  const [inputFields, setInputFields] = useState<SelectToolInputField[]>(initialInputFields)

  // Agentic mode config (Issue #926). Initialized from the existing assistant
  // when editing; defaults to prompt-chain for new assistants.
  const [agentic, setAgentic] = useState<AgenticConfigState>(() => ({
    mode: (initialData?.mode as AgenticConfigState["mode"]) || "prompt_chain",
    enabledTools: initialData?.agentEnabledTools ?? [],
    maxSteps: initialData?.agentMaxSteps ?? 10,
    timeoutSeconds: initialData?.agentTimeoutSeconds ?? 300,
    costCapDollars:
      typeof initialData?.agentCostCapCents === "number"
        ? initialData.agentCostCapCents / 100
        : null,
  }))
  // The mode transition is one-way: an assistant already in agentic mode cannot
  // be reverted, so lock the prompt-chain option when editing such an assistant.
  const lockAgentic = initialData?.mode === "agentic"

  useEffect(() => {
    fetch("/api/assistant-images")
      .then(res => res.json())
      .then(data => setImages(data.images))
      .catch(() => setImages([]))
  }, [])

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initialData?.name || "",
      description: initialData?.description || "",
      imagePath: initialData?.imagePath || ""
    }
  })

  const saveAssistant = useCallback(async (): Promise<string | null> => {
    const values = form.getValues()
    const isValid = await form.trigger()
    if (!isValid) return null

    const agenticPayload = toAgenticPayload(agentic)

    try {
      setIsSubmitting(true)
      if (assistantId) {
        const result = await updateAssistantArchitectAction(assistantId, {
          ...values,
          ...agenticPayload,
        })
        if (!result.isSuccess) throw new Error(result.message)
        return assistantId
      }
      const result = await createAssistantArchitectAction({
        name: values.name,
        description: values.description || "",
        imagePath: values.imagePath,
        status: "draft",
        ...agenticPayload,
      })
      if (!result.isSuccess) throw new Error(result.message)
      const newId = String(result.data.id)
      setAssistantId(newId)
      return newId
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save assistant",
        variant: "destructive"
      })
      return null
    } finally {
      setIsSubmitting(false)
    }
  }, [form, assistantId, toast, agentic])

  const handleAddField = useCallback(async () => saveAssistant(), [saveAssistant])

  const handleSaveField = useCallback(async (
    data: InputFieldData,
    editingField: SelectToolInputField | null
  ) => {
    if (!assistantId) return
    if (editingField) {
      const result = await updateInputFieldAction(String(editingField.id), {
        name: data.name, label: data.label, fieldType: data.fieldType,
        position: data.position, options: data.options
      })
      if (!result.isSuccess) throw new Error(result.message)
      setInputFields(prev => prev.map(f =>
        f.id === editingField.id ? { ...f, ...data, options: data.options ?? null } : f
      ))
      toast({ title: "Success", description: "Input field updated" })
    } else {
      const result = await addToolInputFieldAction(assistantId, {
        name: data.name, label: data.label, type: data.fieldType,
        position: data.position, options: data.options
      })
      if (!result.isSuccess) throw new Error(result.message)
      if (result.data) setInputFields(prev => [...prev, result.data])
      toast({ title: "Success", description: "Input field added" })
    }
  }, [assistantId, toast])

  const handleDeleteField = useCallback(async (field: SelectToolInputField) => {
    const result = await deleteInputFieldAction(String(field.id))
    if (!result.isSuccess) {
      toast({ title: "Error", description: result.message, variant: "destructive" })
      return
    }
    setInputFields(prev => prev.filter(f => f.id !== field.id))
    toast({ title: "Success", description: "Input field deleted" })
  }, [toast])

  const handleContinue = useCallback(async () => {
    const savedId = await saveAssistant()
    if (savedId) {
      toast({
        title: "Success",
        description: initialData ? "Assistant updated" : "Assistant created"
      })
      router.push(`/utilities/assistant-architect/${savedId}/edit/prompts`)
    }
  }, [saveAssistant, toast, initialData, router])

  return (
    <div className="space-y-8">
      <Form {...form}>
        <form className="space-y-6">
          <AssistantDetailsForm control={form.control} images={images} />
        </form>
      </Form>

      <AgenticModeSection
        value={agentic}
        onChange={setAgentic}
        lockAgentic={lockAgentic}
        disabled={isSubmitting}
      />

      <InputFieldsSection
        inputFields={inputFields}
        onAddField={handleAddField}
        onSaveField={handleSaveField}
        onDeleteField={handleDeleteField}
        isSubmitting={isSubmitting}
      />

      <div className="flex justify-end pt-4 border-t">
        <Button onClick={handleContinue} disabled={isSubmitting}>
          {isSubmitting ? "Saving..." : "Continue"}
        </Button>
      </div>
    </div>
  )
}
