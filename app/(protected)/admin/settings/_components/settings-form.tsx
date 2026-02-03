"use client"

import { useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { Setting } from "@/actions/db/settings-actions"

const formSchema = z.object({
  key: z.string().min(1, "Key is required").regex(/^[A-Z][A-Z0-9_]*$/, "Key must start with uppercase letter, and contain only uppercase letters, numbers, and underscores"),
  value: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  isSecret: z.boolean()
})

type FormValues = z.infer<typeof formSchema>

interface SettingsFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (data: FormValues) => Promise<void>
  setting: Setting | null
}

const categories = [
  { value: "ai", label: "AI Configuration" },
  { value: "ai_providers", label: "AI Providers" },
  { value: "storage", label: "Storage" },
  { value: "external_services", label: "External Services" },
]

const commonSettings = [
  { key: "AZURE_OPENAI_KEY", category: "ai_providers", description: "Azure OpenAI API key for GPT models", isSecret: true },
  { key: "AZURE_OPENAI_ENDPOINT", category: "ai_providers", description: "Azure OpenAI endpoint URL", isSecret: false },
  { key: "AZURE_OPENAI_RESOURCENAME", category: "ai_providers", description: "Azure OpenAI resource name", isSecret: false },
  { key: "BEDROCK_ACCESS_KEY_ID", category: "ai_providers", description: "AWS Bedrock access key ID", isSecret: true },
  { key: "BEDROCK_SECRET_ACCESS_KEY", category: "ai_providers", description: "AWS Bedrock secret access key", isSecret: true },
  { key: "BEDROCK_REGION", category: "ai_providers", description: "AWS Bedrock region (e.g., us-east-1)", isSecret: false },
  { key: "GOOGLE_API_KEY", category: "ai_providers", description: "Google AI API key for Gemini models", isSecret: true },
  { key: "OPENAI_API_KEY", category: "ai_providers", description: "OpenAI API key for GPT models", isSecret: true },
  { key: "LATIMER_API_KEY", category: "ai_providers", description: "Latimer.ai API key", isSecret: true },
  { key: "S3_BUCKET", category: "storage", description: "AWS S3 bucket name for document storage", isSecret: false },
  { key: "AWS_REGION", category: "storage", description: "AWS region for S3 operations", isSecret: false },
  { key: "GITHUB_ISSUE_TOKEN", category: "external_services", description: "GitHub personal access token for creating issues", isSecret: true },
]

export function SettingsForm({ open, onOpenChange, onSave, setting }: SettingsFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      key: "",
      value: null,
      description: null,
      category: null,
      isSecret: false
    }
  })

  useEffect(() => {
    if (!open) {
      // Reset submission state when dialog closes
      setIsSubmitting(false)
    }
    
    if (setting) {
      // If editing a secret with masked value, clear the value field
      const value = (setting.isSecret && setting.value === '••••••••') ? '' : setting.value
      form.reset({
        key: setting.key,
        value: value,
        description: setting.description,
        category: setting.category,
        isSecret: setting.isSecret ?? false
      })
    } else {
      form.reset({
        key: "",
        value: null,
        description: null,
        category: null,
        isSecret: false
      })
    }
  }, [setting, form, open])

  const handleSubmit = async (values: FormValues) => {
    setIsSubmitting(true)
    try {
      await onSave(values)
    } catch {
      // Error is already handled in the parent component
      // Just reset the submitting state
      setIsSubmitting(false)
      return
    }
    setIsSubmitting(false)
  }

  const handleKeySelect = (key: string) => {
    const preset = commonSettings.find(s => s.key === key)
    if (preset) {
      form.setValue("key", preset.key)
      form.setValue("category", preset.category)
      form.setValue("description", preset.description)
      form.setValue("isSecret", preset.isSecret)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]" onInteractOutside={(e) => {
        if (isSubmitting) {
          e.preventDefault()
        }
      }}>
        <DialogHeader>
          <DialogTitle>{setting ? "Edit Setting" : "Add Setting"}</DialogTitle>
          <DialogDescription>
            {setting 
              ? "Update the configuration setting. Changes take effect immediately."
              : "Add a new configuration setting. You can select from common settings or create a custom one."
            }
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            {!setting && (
              <FormField
                control={form.control}
                name="key"
                render={() => (
                  <FormItem>
                    <FormLabel>Common Settings</FormLabel>
                    <Select onValueChange={handleKeySelect}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a common setting or enter custom" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {commonSettings.map((s) => (
                          <SelectItem key={s.key} value={s.key}>
                            {s.key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Select from common settings to auto-fill fields
                    </FormDescription>
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="key"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Key</FormLabel>
                  <FormControl>
                    <Input 
                      {...field} 
                      placeholder="SETTING_KEY" 
                      disabled={!!setting}
                      className="font-mono"
                    />
                  </FormControl>
                  <FormDescription>
                    Uppercase letters, numbers, underscores (e.g., API_KEY, S3_BUCKET)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="value"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Value</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value || ""}
                      placeholder={
                        setting?.isSecret && setting?.hasValue 
                          ? "Enter new value (leave empty to keep current value)" 
                          : "Enter the setting value"
                      }
                      className="font-mono resize-none"
                      rows={3}
                    />
                  </FormControl>
                  <FormDescription>
                    {setting?.isSecret && setting?.hasValue 
                      ? "Current value is hidden. Enter a new value to update, or leave empty to keep the current value."
                      : "The value for this setting. Leave empty to use environment variable fallback."
                    }
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <Select 
                    onValueChange={field.onChange} 
                    value={field.value || ""}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {categories.map((cat) => (
                        <SelectItem key={cat.value} value={cat.value}>
                          {cat.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Group related settings together
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value || ""}
                      placeholder="Describe what this setting is used for"
                      rows={2}
                    />
                  </FormControl>
                  <FormDescription>
                    Help text to explain the purpose of this setting
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isSecret"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>
                      Secret Value
                    </FormLabel>
                    <FormDescription>
                      Mark this setting as secret to hide its value in the UI
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : (setting ? "Update" : "Create")}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}