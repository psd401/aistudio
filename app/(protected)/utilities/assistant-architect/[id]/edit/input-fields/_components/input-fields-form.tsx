"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { addToolInputFieldAction, updateInputFieldAction } from "@/actions/db/assistant-architect-actions"
import type { SelectToolInputField, ToolInputFieldOptions } from "@/types"

const baseFormSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(24, "Name must be 24 characters or less")
    .regex(/^[\d_a-z]+$/, "Name must be a single word, lowercase, and only contain letters, numbers, or underscores (no spaces or special characters)"),
  label: z.string().min(1, "Label is required"),
  fieldType: z.enum(["short_text", "long_text", "select", "multi_select", "file_upload"]),
  position: z.number().int().min(0),
  options: z.array(
    z.object({
      label: z.string().min(1, "Option label is required"),
      value: z.string().min(1, "Option value is required")
    })
  ).optional()
})

type FormValues = z.infer<typeof baseFormSchema>

interface InputFieldsFormProps {
  assistantId: string
  inputFields: SelectToolInputField[]
  editingField?: SelectToolInputField | null
  clearEditingField?: () => void
}

export function InputFieldsForm({ 
  assistantId, 
  inputFields, 
  editingField = null, 
  clearEditingField 
}: InputFieldsFormProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(false)
  const [showOptions, setShowOptions] = useState(false)
  const [options, setOptions] = useState<{ label: string; value: string }[]>([])
  const [newOption, setNewOption] = useState({ label: "", value: "" })
  const isEditing = !!editingField

  const form = useForm<FormValues>({
    resolver: zodResolver(
      baseFormSchema.refine(
        (values) => {
          // Exclude the currently edited field from the duplicate check
          return !inputFields.some(f => f.name === values.name && (!editingField || f.id !== editingField.id))
        },
        { message: "Name must be unique. Another field with this name already exists.", path: ["name"] }
      )
    ),
    defaultValues: {
      name: "",
      label: "",
      fieldType: "short_text",
      position: inputFields.length,
      options: []
    }
  })

  const watchFieldType = form.watch("fieldType") as FormValues["fieldType"]

  // Set form values when editing a field
  useEffect(() => {
    if (editingField) {
      let parsedOptions: { label: string; value: string }[] = [];
      // editingField.options is ToolInputFieldOptions | null from Drizzle JSONB type
      // ToolInputFieldOptions has values?: string[]
      if (editingField.options && typeof editingField.options === 'object') {
        const opts = editingField.options as ToolInputFieldOptions;
        if (Array.isArray(opts.values)) {
          parsedOptions = opts.values.map(val => ({
            label: val,
            value: val
          }));
        }
      }
      form.reset({
        name: editingField.name,
        label: editingField.label ?? editingField.name,
        fieldType: editingField.fieldType as "short_text" | "long_text" | "select" | "multi_select" | "file_upload",
        position: editingField.position,
        options: parsedOptions,
      });
      setOptions(parsedOptions);
    }
  }, [editingField, form])

  // Update showOptions when field type changes
  useEffect(() => {
    const shouldShowOptions = watchFieldType === "select" || watchFieldType === "multi_select"
    setShowOptions(shouldShowOptions)
    if (!shouldShowOptions) {
      setOptions([])
      form.setValue("options" as const, [])
    }
  }, [watchFieldType, form])

  function handleAddOption() {
    if (newOption.label && newOption.value) {
      const updatedOptions = [...options, newOption]
      setOptions(updatedOptions)
      form.setValue("options" as const, updatedOptions)
      setNewOption({ label: "", value: "" })
    }
  }

  function handleRemoveOption(index: number) {
    const updatedOptions = options.filter((_, i) => i !== index)
    setOptions(updatedOptions)
    form.setValue("options" as const, updatedOptions)
  }

  async function onSubmit(values: FormValues) {
    try {
      setIsLoading(true)

      // Only include options for select/multi_select fields
      const hasOptions = showOptions && options.length > 0

      let result;

      if (isEditing && editingField) {
        // Update existing field - updateInputFieldAction expects ToolInputFieldOptions format
        const optionsForUpdate: ToolInputFieldOptions | undefined = hasOptions
          ? { values: options.map(opt => opt.value) }
          : undefined

        result = await updateInputFieldAction(
          String(editingField.id),
          {
            name: values.name as string,
            label: values.label as string,
            fieldType: values.fieldType as "short_text" | "long_text" | "select" | "multi_select" | "file_upload",
            position: values.position as number,
            options: optionsForUpdate
          }
        )

        if (clearEditingField) {
          clearEditingField()
        }
      } else {
        // Create new field - addToolInputFieldAction expects { label, value }[] format
        const optionsForCreate = hasOptions ? options : undefined

        result = await addToolInputFieldAction(
          assistantId,
          {
            name: values.name as string,
            label: values.label as string,
            type: values.fieldType as "short_text" | "long_text" | "select" | "multi_select" | "file_upload",
            position: values.position as number,
            options: optionsForCreate
          }
        )
      }

      if (!result.isSuccess) {
        throw new Error(result.message)
      }

      toast({
        title: "Success",
        description: isEditing 
          ? "Input field updated successfully" 
          : "Input field added successfully"
      })

      // Reset form
      form.reset({
        name: "",
        label: "",
        fieldType: "short_text",
        position: inputFields.length + (isEditing ? 0 : 1),
        options: []
      })
      setOptions([])
      router.refresh()
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save input field",
        variant: "destructive"
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="Enter field name..." onChange={e => field.onChange(e.target.value.toLowerCase())} />
                </FormControl>
                <FormMessage />
                <FormDescription>
                  <span className="font-semibold">Short, unique identifier</span> for this field. Use a single lowercase word (e.g. <code>goal</code>, <code>email</code>, <code>age</code>). This is used internally and for variable mapping in prompts. No spaces or special characters.
                </FormDescription>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="label"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Label</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="Enter field label..." />
                </FormControl>
                <FormMessage />
                <FormDescription>
                  <span className="font-semibold">User-facing label</span> for this field. This can be a longer description or instructions (e.g. <code>Describe your wellness goal in one sentence</code>). Shown to users in forms and variable mapping.
                </FormDescription>
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="fieldType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Field Type</FormLabel>
                  <Select
                    onValueChange={(value) => {
                      field.onChange(value)
                      const shouldShowOptions = value === "select" || value === "multi_select"
                      setShowOptions(shouldShowOptions)
                      if (!shouldShowOptions) {
                        setOptions([])
                        form.setValue("options" as const, [])
                      }
                    }}
                    defaultValue={field.value}
                    value={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a field type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="short_text">Short Text</SelectItem>
                      <SelectItem value="long_text">Long Text</SelectItem>
                      <SelectItem value="select">Single Select</SelectItem>
                      <SelectItem value="multi_select">Multi Select</SelectItem>
                      <SelectItem value="file_upload">File Upload (PDF)</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                  <FormDescription>
                    Type of input field (text, select, etc.)
                  </FormDescription>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="position"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Position</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min="0"
                      {...field}
                      onChange={(e) => field.onChange(Number.parseInt(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                  <FormDescription>
                    Order in which this field appears (lower numbers first)
                  </FormDescription>
                </FormItem>
              )}
            />
          </div>

          {showOptions && (
            <div className="border rounded-md p-4 space-y-4">
              <h3 className="text-sm font-medium">Options</h3>
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
                <div>
                  <FormLabel>Label</FormLabel>
                  <Input
                    value={newOption.label}
                    onChange={(e) => setNewOption({ ...newOption, label: e.target.value })}
                    placeholder="Option Label"
                  />
                </div>
                <div>
                  <FormLabel>Value</FormLabel>
                  <Input
                    value={newOption.value}
                    onChange={(e) => setNewOption({ ...newOption, value: e.target.value })}
                    placeholder="Option Value"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddOption}
                  disabled={!newOption.label || !newOption.value}
                >
                  Add
                </Button>
              </div>
              
              {options.length > 0 && (
                <div className="space-y-2 mt-4">
                  <h4 className="text-sm font-medium">Defined Options</h4>
                  {options.map((option, index) => (
                    <div key={index} className="flex items-center justify-between border p-2 rounded-md">
                      <div>
                        <span className="font-medium">{option.label}</span>
                        <span className="text-muted-foreground ml-2">({option.value})</span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveOption(index)}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <FormDescription>
                Available options for select fields
              </FormDescription>
            </div>
          )}

          <div className="flex justify-end space-x-2">
            {!isEditing && (
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push(`/utilities/assistant-architect/${assistantId}/edit/prompts`)}
              >
                Skip
              </Button>
            )}
            <Button type="submit" disabled={isLoading}>
              {isLoading 
                ? (isEditing ? "Updating..." : "Adding...") 
                : (isEditing ? "Update Field" : "Add Field")
              }
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
} 