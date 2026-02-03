"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { createPrompt } from "@/actions/prompt-library.actions"
import { useAction } from "@/lib/hooks/use-action"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import { ArrowLeft, Save } from "lucide-react"
import { TagInput } from "../_components/tag-input"
import { PageBranding } from "@/components/ui/page-branding"
import type { PromptVisibility } from "@/lib/prompt-library/types"
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

  const { execute: executeCreate, isPending: isCreating } = useAction(createPrompt, {
    onSuccess: (data) => {
      toast.success("Prompt created successfully")
      // Redirect to view the newly created prompt
      router.push(`/prompt-library/${data.id}`)
    },
    onError: (error) => {
      toast.error(error)
    }
  })

  const handleCreate = async () => {
    // Validate using Zod schema for consistency with server-side validation
    const validation = createPromptSchema.safeParse(formData)
    if (!validation.success) {
      const firstError = validation.error.issues[0]
      toast.error(firstError.message)
      return
    }

    await executeCreate({
      title: formData.title,
      content: formData.content,
      description: formData.description || undefined,
      visibility: formData.visibility,
      tags: formData.tags
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

      {/* Form */}
      <Card>
        <CardHeader>
          <CardTitle>Prompt Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">
              Title * ({formData.title.length}/255)
            </Label>
            <Input
              id="title"
              value={formData.title}
              onChange={(e) =>
                setFormData({ ...formData, title: e.target.value })
              }
              placeholder="Enter prompt title"
              maxLength={255}
              aria-required="true"
              aria-invalid={!formData.title}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">
              Description ({formData.description.length}/1000)
            </Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              placeholder="Enter a brief description"
              rows={3}
              maxLength={1000}
            />
          </div>

          {/* Content */}
          <div className="space-y-2">
            <Label htmlFor="content">
              Prompt Content * ({formData.content.length}/50000)
            </Label>
            <Textarea
              id="content"
              value={formData.content}
              onChange={(e) =>
                setFormData({ ...formData, content: e.target.value })
              }
              placeholder="Enter your prompt content"
              rows={10}
              className="font-mono"
              maxLength={50000}
              aria-required="true"
              aria-invalid={!formData.content}
            />
            <p className="text-xs text-muted-foreground">
              Use variables like {`{{variable_name}}`} for dynamic content
            </p>
          </div>

          {/* Tags */}
          <div className="space-y-2">
            <Label htmlFor="tags">Tags</Label>
            <TagInput
              value={formData.tags}
              onChange={(tags) => setFormData({ ...formData, tags })}
            />
          </div>

          {/* Visibility */}
          <div className="space-y-2">
            <Label htmlFor="visibility">Visibility</Label>
            <Select
              value={formData.visibility}
              onValueChange={(value: PromptVisibility) =>
                setFormData({ ...formData, visibility: value })
              }
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private</SelectItem>
                <SelectItem value="public">Public</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Public prompts will be visible to all users after moderation
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
