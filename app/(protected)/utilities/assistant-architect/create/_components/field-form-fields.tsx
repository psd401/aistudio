"use client"

import { useCallback } from "react"
import {
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
import type { Control, ControllerRenderProps } from "react-hook-form"

interface FormValues {
  name: string
  label: string
  fieldType: "short_text" | "long_text" | "select" | "multi_select" | "file_upload"
  position: number
}

const FIELD_TYPE_DESCRIPTIONS: Record<string, string> = {
  short_text: "Single line text input for brief responses",
  long_text: "Multi-line text area for detailed responses",
  select: "Dropdown menu where user selects one option",
  multi_select: "Dropdown menu where user selects multiple options",
  file_upload: "Allow users to upload PDF files"
}

function NameFieldContent({ field }: { field: ControllerRenderProps<FormValues, "name"> }) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => field.onChange(e.target.value.toLowerCase()),
    [field]
  )

  return (
    <FormItem>
      <FormLabel>Name</FormLabel>
      <FormControl>
        <Input {...field} placeholder="e.g., goal, email" onChange={handleChange} />
      </FormControl>
      <FormMessage />
      <FormDescription className="text-xs">Unique identifier (lowercase, no spaces)</FormDescription>
    </FormItem>
  )
}

export function NameField({ control }: { control: Control<FormValues> }) {
  const renderName = useCallback(
    ({ field }: { field: ControllerRenderProps<FormValues, "name"> }) => <NameFieldContent field={field} />,
    []
  )
  return <FormField control={control} name="name" render={renderName} />
}

function LabelFieldContent({ field }: { field: ControllerRenderProps<FormValues, "label"> }) {
  return (
    <FormItem>
      <FormLabel>Label</FormLabel>
      <FormControl>
        <Input {...field} placeholder="Display label for users" />
      </FormControl>
      <FormMessage />
      <FormDescription className="text-xs">What users will see</FormDescription>
    </FormItem>
  )
}

export function LabelField({ control }: { control: Control<FormValues> }) {
  const renderLabel = useCallback(
    ({ field }: { field: ControllerRenderProps<FormValues, "label"> }) => <LabelFieldContent field={field} />,
    []
  )
  return <FormField control={control} name="label" render={renderLabel} />
}

interface FieldTypeFieldProps {
  control: Control<FormValues>
  onTypeChange: (value: string) => void
}

function FieldTypeFieldContent({
  field,
  onTypeChange
}: {
  field: ControllerRenderProps<FormValues, "fieldType">
  onTypeChange: (value: string) => void
}) {
  // Fresh handler each render - avoids stale closure with form.reset()
  const handleChange = (value: string) => {
    field.onChange(value)
    onTypeChange(value)
  }

  return (
    <FormItem>
      <FormLabel>Field Type</FormLabel>
      {/* Use defaultValue instead of value for proper sync after form.reset() */}
      <Select onValueChange={handleChange} defaultValue={field.value}>
        <FormControl>
          <SelectTrigger>
            <SelectValue placeholder="Select type" />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          <SelectItem value="short_text">Short Text</SelectItem>
          <SelectItem value="long_text">Long Text</SelectItem>
          <SelectItem value="select">Single Select</SelectItem>
          <SelectItem value="multi_select">Multi Select</SelectItem>
          <SelectItem value="file_upload">File Upload</SelectItem>
        </SelectContent>
      </Select>
      <FormMessage />
      <FormDescription className="text-xs">{FIELD_TYPE_DESCRIPTIONS[field.value]}</FormDescription>
    </FormItem>
  )
}

export function FieldTypeField({ control, onTypeChange }: FieldTypeFieldProps) {
  const renderFieldType = useCallback(
    ({ field }: { field: ControllerRenderProps<FormValues, "fieldType"> }) => (
      <FieldTypeFieldContent field={field} onTypeChange={onTypeChange} />
    ),
    [onTypeChange]
  )
  return <FormField control={control} name="fieldType" render={renderFieldType} />
}

function PositionFieldContent({ field }: { field: ControllerRenderProps<FormValues, "position"> }) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => field.onChange(Number.parseInt(e.target.value)),
    [field]
  )

  return (
    <FormItem>
      <FormLabel>Position</FormLabel>
      <FormControl>
        <Input type="number" min="0" value={field.value} onChange={handleChange} />
      </FormControl>
      <FormMessage />
      <FormDescription className="text-xs">Display order (lower = first)</FormDescription>
    </FormItem>
  )
}

export function PositionField({ control }: { control: Control<FormValues> }) {
  const renderPosition = useCallback(
    ({ field }: { field: ControllerRenderProps<FormValues, "position"> }) => <PositionFieldContent field={field} />,
    []
  )
  return <FormField control={control} name="position" render={renderPosition} />
}
