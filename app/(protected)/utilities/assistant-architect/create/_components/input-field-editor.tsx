"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Form } from "@/components/ui/form"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import type { SelectToolInputField, ToolInputFieldOptions } from "@/types"
import { X } from "lucide-react"
import { FieldOptionsEditor } from "./field-options-editor"
import { NameField, LabelField, FieldTypeField, PositionField } from "./field-form-fields"

const baseFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(24, "Name must be 24 characters or less")
    .regex(/^[\d_a-z]+$/, "Name must be lowercase with no spaces"),
  label: z.string().min(1, "Label is required"),
  fieldType: z.enum(["short_text", "long_text", "select", "multi_select", "file_upload"]),
  position: z.number().int().min(0),
})

type FormValues = z.infer<typeof baseFormSchema>

export interface InputFieldData {
  name: string
  label: string
  fieldType: "short_text" | "long_text" | "select" | "multi_select" | "file_upload"
  position: number
  options?: ToolInputFieldOptions
}

interface InputFieldEditorProps {
  existingFields: SelectToolInputField[]
  editingField?: SelectToolInputField | null
  onSave: (data: InputFieldData) => Promise<void>
  onCancel: () => void
  nextPosition: number
}

export function InputFieldEditor({
  existingFields, editingField, onSave, onCancel, nextPosition
}: InputFieldEditorProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [showOptions, setShowOptions] = useState(false)
  const [options, setOptions] = useState<{ label: string; value: string }[]>([])
  const isEditing = !!editingField

  const form = useForm<FormValues>({
    resolver: zodResolver(
      baseFormSchema.refine(
        (values) => !existingFields.some(
          f => f.name === values.name && (!editingField || f.id !== editingField.id)
        ),
        { message: "Name must be unique", path: ["name"] }
      )
    ),
    defaultValues: { name: "", label: "", fieldType: "short_text", position: nextPosition }
  })

  useEffect(() => {
    if (editingField) {
      let parsedOptions: { label: string; value: string }[] = []
      const opts = editingField.options

      // Handle both storage formats:
      // 1. New format: { values: ["val1", "val2"] } - from createToolInputField
      // 2. Legacy/import format: [{ label: "Label", value: "val" }, ...] - from JSON imports
      if (opts) {
        if (Array.isArray(opts)) {
          // Legacy format: array of {label, value} objects
          parsedOptions = (opts as { label: string; value: string }[]).map(opt => ({
            label: opt.label || opt.value,
            value: opt.value
          }))
        } else if ((opts as ToolInputFieldOptions)?.values && Array.isArray((opts as ToolInputFieldOptions).values)) {
          // New format: object with values array
          parsedOptions = (opts as ToolInputFieldOptions).values!.map(val => ({ label: val, value: val }))
        }
      }

      form.reset({
        name: editingField.name,
        label: editingField.label ?? editingField.name,
        fieldType: editingField.fieldType as FormValues["fieldType"],
        position: editingField.position,
      })
      setOptions(parsedOptions)
      setShowOptions(editingField.fieldType === "select" || editingField.fieldType === "multi_select")
    } else {
      form.reset({ name: "", label: "", fieldType: "short_text", position: nextPosition })
      setOptions([])
      setShowOptions(false)
    }
  }, [editingField, form, nextPosition])

  const handleTypeChange = useCallback((value: string) => {
    const shouldShow = value === "select" || value === "multi_select"
    setShowOptions(shouldShow)
    if (!shouldShow) setOptions([])
  }, [])

  const onSubmit = useCallback(async (values: FormValues) => {
    try {
      setIsLoading(true)
      const optionsToSave: ToolInputFieldOptions | undefined =
        showOptions && options.length > 0
          ? { values: options.map(opt => opt.value).filter(v => v.trim()) }
          : undefined
      await onSave({ ...values, options: optionsToSave })
      form.reset({ name: "", label: "", fieldType: "short_text", position: nextPosition + 1 })
      setOptions([])
    } finally {
      setIsLoading(false)
    }
  }, [showOptions, options, onSave, form, nextPosition])

  return (
    <div className="border rounded-lg p-4 bg-muted/30">
      <div className="flex items-center justify-between mb-4">
        <h4 className="font-medium">
          {isEditing ? `Edit Field: ${editingField?.label || editingField?.name}` : "Add Input Field"}
        </h4>
        <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label="Cancel">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <NameField control={form.control} />
            <LabelField control={form.control} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FieldTypeField control={form.control} onTypeChange={handleTypeChange} />
            <PositionField control={form.control} />
          </div>
          {showOptions && <FieldOptionsEditor options={options} onOptionsChange={setOptions} />}
          <div className="flex justify-end space-x-2 pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? (isEditing ? "Updating..." : "Adding...") : (isEditing ? "Update Field" : "Add Field")}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
