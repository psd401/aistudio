"use client"

import { useCallback } from "react"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { Control, ControllerRenderProps } from "react-hook-form"
import { IconPicker } from "./icon-picker"

interface FormValues {
  name: string
  description?: string
  imagePath: string
}

interface AssistantDetailsFormProps {
  control: Control<FormValues>
  images: string[]
}

export function AssistantDetailsForm({ control, images }: AssistantDetailsFormProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-medium">Assistant Identity</h3>
      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6">
        <IconPicker control={control} images={images} />

        <div className="space-y-4">
          <NameField control={control} />
          <DescriptionField control={control} />
        </div>
      </div>
    </div>
  )
}

function NameFieldContent({ field }: { field: ControllerRenderProps<FormValues, "name"> }) {
  return (
    <FormItem>
      <FormLabel>Name</FormLabel>
      <FormControl>
        <Input placeholder="Enter assistant name..." {...field} />
      </FormControl>
      <FormDescription>A descriptive name for your assistant.</FormDescription>
      <FormMessage />
    </FormItem>
  )
}

function NameField({ control }: { control: Control<FormValues> }) {
  const renderName = useCallback(
    ({ field }: { field: ControllerRenderProps<FormValues, "name"> }) => (
      <NameFieldContent field={field} />
    ),
    []
  )

  return <FormField control={control} name="name" render={renderName} />
}

function DescriptionFieldContent({ field }: { field: ControllerRenderProps<FormValues, "description"> }) {
  return (
    <FormItem>
      <FormLabel>Description</FormLabel>
      <FormControl>
        <Textarea placeholder="Enter assistant description..." rows={4} {...field} />
      </FormControl>
      <FormDescription>A brief description of what your assistant does.</FormDescription>
      <FormMessage />
    </FormItem>
  )
}

function DescriptionField({ control }: { control: Control<FormValues> }) {
  const renderDescription = useCallback(
    ({ field }: { field: ControllerRenderProps<FormValues, "description"> }) => (
      <DescriptionFieldContent field={field} />
    ),
    []
  )

  return <FormField control={control} name="description" render={renderDescription} />
}
