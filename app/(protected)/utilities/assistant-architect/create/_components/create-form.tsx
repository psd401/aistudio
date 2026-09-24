"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm, type FieldErrors, type UseFormReturn } from "react-hook-form"
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
import { ModelRoutingSection, type ModelRoutingState } from "./model-routing-section"

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

interface AssistantSetupSectionsProps {
  form: UseFormReturn<FormValues>
  images: string[]
  agentic: AgenticConfigState
  onAgenticChange: (value: AgenticConfigState) => void
  routing: ModelRoutingState
  onRoutingChange: (value: ModelRoutingState) => void
  lockAgentic: boolean
  disabled: boolean
}

function AssistantSetupSections({
  form,
  images,
  agentic,
  onAgenticChange,
  routing,
  onRoutingChange,
  lockAgentic,
  disabled,
}: AssistantSetupSectionsProps) {
  return (
    <>
      <Form {...form}>
        {/*
          The Continue / Add Field buttons live OUTSIDE this <form>, so it has
          no submit button and never had an onSubmit. With a single text input
          in it, the browser's implicit-submission rule fires on Enter in the
          Name field: a native GET to the current URL with the field values as
          query params, i.e. a full page reload that silently discards the
          whole draft. Same class of "the form is broken" symptom as #1697.
        */}
        <form className="space-y-6" onSubmit={event => event.preventDefault()}>
          <AssistantDetailsForm control={form.control} images={images} />
        </form>
      </Form>
      <AgenticModeSection
        value={agentic}
        onChange={onAgenticChange}
        lockAgentic={lockAgentic}
        disabled={disabled}
      />
      <ModelRoutingSection
        value={routing}
        onChange={onRoutingChange}
        disabled={disabled}
      />
    </>
  )
}

/**
 * Map the UI agentic config to the server-action payload. Cost cap is whole
 * dollars in the UI; the action/DB store whole cents. Tools are cleared when not
 * in agentic mode so a mode flip doesn't leave a stale tool list.
 */
function toAgenticPayload(agentic: AgenticConfigState) {
  return {
    mode: agentic.mode,
    agentEnabledTools: agentic.mode === "agentic" ? agentic.enabledTools : [],
    agentEnabledConnectors: agentic.mode === "agentic" ? agentic.enabledConnectors : [],
    agentMaxSteps: agentic.maxSteps,
    agentTimeoutSeconds: agentic.timeoutSeconds,
    agentCostCapCents:
      agentic.costCapDollars === null ? null : Math.round(agentic.costCapDollars * 100),
    agentMaxRequestsPerHour: agentic.maxRequestsPerHour,
  }
}

function createInitialRouting(initialData?: SelectAssistantArchitect): ModelRoutingState {
  return {
    mode: initialData?.modelRoutingMode ?? "standard",
    family: initialData?.modelRoutingFamily ?? null,
  }
}

function createInitialAgenticConfig(initialData?: SelectAssistantArchitect): AgenticConfigState {
  return {
    mode: (initialData?.mode as AgenticConfigState["mode"]) || "prompt_chain",
    enabledTools: initialData?.agentEnabledTools ?? [],
    enabledConnectors: initialData?.agentEnabledConnectors ?? [],
    maxSteps: initialData?.agentMaxSteps ?? 10,
    timeoutSeconds: initialData?.agentTimeoutSeconds ?? 300,
    costCapDollars:
      typeof initialData?.agentCostCapCents === "number"
        ? initialData.agentCostCapCents / 100
        : null,
    maxRequestsPerHour:
      typeof initialData?.agentMaxRequestsPerHour === "number"
        ? initialData.agentMaxRequestsPerHour
        : null,
  }
}

/**
 * Validation used to fail silently — saveAssistant() just returned null, so a
 * blocked "Continue" looked exactly like a dead button: no toast, no scroll, no
 * focus, nothing in the console. Say which field is wrong and focus it.
 *
 * The errors are taken from handleSubmit's invalid callback rather than read off
 * `form.formState` after a `trigger()`: that read came back empty (the
 * subscribed formState proxy had not caught up yet), which collapsed every
 * blocked submit to the generic fallback and skipped `setFocus` entirely.
 *
 * This is the ONLY thing that moves focus, which is why the form is created
 * with `shouldFocusError: false`. RHF's own `_focusError()` walks fields in
 * REGISTRATION order and runs after the invalid callback (twice — once
 * synchronously, once on a timeout), so it always won. The icon grid registers
 * first while this names the first error in SCHEMA order, so a blank form told
 * the user "Name must be at least 3 characters" and then put the focus ring on
 * the icon grid. One owner, one field, one message.
 */
/** The selectable assistant icons, loaded once on mount. `[]` if the fetch fails. */
function useAssistantImages(): string[] {
  const [images, setImages] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    fetch("/api/assistant-images")
      .then(res => res.json())
      .then(data => {
        if (!cancelled) setImages(data.images)
      })
      .catch(() => {
        if (!cancelled) setImages([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  return images
}

function reportValidationFailure(
  form: UseFormReturn<FormValues>,
  toast: ReturnType<typeof useToast>["toast"],
  errors: FieldErrors<FormValues>
) {
  const firstField = Object.keys(errors)[0] as keyof FormValues | undefined
  const message =
    firstField && typeof errors[firstField]?.message === "string"
      ? (errors[firstField]?.message as string)
      : "Check the highlighted fields and try again."
  toast({ title: "Cannot continue", description: message, variant: "destructive" })
  if (firstField) form.setFocus(firstField)
}

export function CreateForm({ initialData, initialInputFields = [] }: CreateFormProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const images = useAssistantImages()
  const [assistantId, setAssistantId] = useState<string | null>(
    initialData?.id ? String(initialData.id) : null
  )
  const [inputFields, setInputFields] = useState<SelectToolInputField[]>(initialInputFields)
  const [routing, setRouting] = useState<ModelRoutingState>(() => createInitialRouting(initialData))

  // Agentic mode config (Issue #926). Initialized from the existing assistant
  // when editing; defaults to prompt-chain for new assistants.
  const [agentic, setAgentic] = useState<AgenticConfigState>(
    () => createInitialAgenticConfig(initialData)
  )
  // The mode transition is one-way: an assistant already in agentic mode cannot
  // be reverted, so lock the prompt-chain option when editing such an assistant.
  const lockAgentic = initialData?.mode === "agentic"

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    // reportValidationFailure owns the focus — see its doc comment.
    shouldFocusError: false,
    defaultValues: {
      name: initialData?.name || "",
      description: initialData?.description || "",
      imagePath: initialData?.imagePath || ""
    }
  })


  const persist = useCallback(async (values: FormValues): Promise<string | null> => {
    try {
      // Built inside the try: if either ever throws, the catch reports it
      // instead of the exception escaping an onClick handler as an unhandled
      // rejection with no user feedback.
      const agenticPayload = toAgenticPayload(agentic)
      const routingPayload = {
        modelRoutingMode: routing.mode,
        modelRoutingFamily: routing.mode === "advanced" ? routing.family : null,
      }
      if (assistantId) {
        const result = await updateAssistantArchitectAction(assistantId, {
          ...values,
          ...agenticPayload,
          ...routingPayload,
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
        ...routingPayload,
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
    }
  }, [assistantId, toast, agentic, routing])

  /**
   * `handleSubmit` is used instead of `trigger()` so the invalid branch receives
   * the real errors object (see reportValidationFailure). It awaits the async
   * valid handler, so `savedId` is settled by the time it resolves.
   *
   * `isSubmitting` is raised HERE, not inside persist(): the zod resolver is
   * async, so two fast clicks both cleared validation before either flipped the
   * flag and both created a draft assistant.
   */
  const saveAssistant = useCallback(async (): Promise<string | null> => {
    let savedId: string | null = null
    setIsSubmitting(true)
    try {
      await form.handleSubmit(
        async (values) => {
          savedId = await persist(values)
        },
        errors => reportValidationFailure(form, toast, errors)
      )()
    } finally {
      setIsSubmitting(false)
    }
    return savedId
  }, [form, persist, toast])

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
      <AssistantSetupSections
        form={form}
        images={images}
        agentic={agentic}
        onAgenticChange={setAgentic}
        routing={routing}
        onRoutingChange={setRouting}
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
