"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { createPrompt } from "@/actions/prompt-library.actions"
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
import type { PromptVisibility } from "@/lib/prompt-library/types"

export default function NewPromptPage() {
  const router = useRouter()
  const [isCreating, setIsCreating] = useState(false)
  const [formData, setFormData] = useState({
    title: '',
    content: '',
    description: '',
    visibility: 'private' as PromptVisibility,
    tags: [] as string[]
  })

  const handleCreate = async () => {
    if (!formData.title || !formData.content) {
      toast.error("Title and content are required")
      return
    }

    setIsCreating(true)
    const result = await createPrompt({
      title: formData.title,
      content: formData.content,
      description: formData.description || undefined,
      visibility: formData.visibility,
      tags: formData.tags
    })

    if (result?.isSuccess) {
      toast.success("Prompt created successfully")
      // Redirect to the edit page for the newly created prompt
      router.push(`/prompt-library/${result.data.id}`)
    } else {
      toast.error(result?.message || "Failed to create prompt")
      setIsCreating(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/prompt-library')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-semibold">Create New Prompt</h1>
        </div>

        <Button
          onClick={handleCreate}
          disabled={isCreating}
        >
          <Save className="mr-2 h-4 w-4" />
          {isCreating ? 'Creating...' : 'Create Prompt'}
        </Button>
      </div>

      {/* Form */}
      <Card>
        <CardHeader>
          <CardTitle>Prompt Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">Title *</Label>
            <Input
              id="title"
              value={formData.title}
              onChange={(e) =>
                setFormData({ ...formData, title: e.target.value })
              }
              placeholder="Enter prompt title"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              placeholder="Enter a brief description"
              rows={3}
            />
          </div>

          {/* Content */}
          <div className="space-y-2">
            <Label htmlFor="content">Prompt Content *</Label>
            <Textarea
              id="content"
              value={formData.content}
              onChange={(e) =>
                setFormData({ ...formData, content: e.target.value })
              }
              placeholder="Enter your prompt content"
              rows={10}
              className="font-mono"
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
