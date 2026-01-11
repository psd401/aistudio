"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { useAction } from "@/lib/hooks/use-action"
import { getPrompt, updatePrompt, deletePrompt } from "@/actions/prompt-library.actions"
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
import { ArrowLeft, Save, Trash2 } from "lucide-react"
import { TagInput } from "../_components/tag-input"
import { PageBranding } from "@/components/ui/page-branding"
import type { Prompt, PromptVisibility } from "@/lib/prompt-library/types"

export default function PromptEditPage() {
  const params = useParams()
  const router = useRouter()
  const promptId = params.id as string

  const [formData, setFormData] = useState<Partial<Prompt>>({
    title: '',
    content: '',
    description: '',
    visibility: 'private',
    tags: []
  })
  const [loading, setLoading] = useState(true)
  const [promptData, setPromptData] = useState<Prompt | null>(null)

  const { execute: executeGet } = useAction(getPrompt, {
    showSuccessToast: false,
    showErrorToast: false
  })
  const { execute: executeDelete, isPending: isDeleting } = useAction(deletePrompt)
  const [isUpdating, setIsUpdating] = useState(false)

  // Load prompt
  useEffect(() => {
    async function loadPrompt() {
      setLoading(true)
      const result = await executeGet(promptId)

      if (result?.isSuccess && result.data) {
        setPromptData(result.data)
        setFormData({
          title: result.data.title,
          content: result.data.content,
          description: result.data.description || '',
          visibility: result.data.visibility,
          tags: result.data.tags || []
        })
      }
      setLoading(false)
    }

    if (promptId) {
      loadPrompt()
    }
  }, [promptId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!formData.title || !formData.content) {
      toast.error("Title and content are required")
      return
    }

    setIsUpdating(true)
    const result = await updatePrompt(promptId, {
      title: formData.title,
      content: formData.content,
      description: formData.description || undefined,
      visibility: formData.visibility,
      tags: formData.tags
    })

    if (result?.isSuccess) {
      toast.success("Prompt updated successfully")
    } else {
      toast.error(result?.message || "Failed to update prompt")
    }
    setIsUpdating(false)
  }

  const handleDelete = async () => {
    if (confirm("Are you sure you want to delete this prompt?")) {
      const result = await executeDelete(promptId)

      if (result?.isSuccess) {
        toast.success("Prompt deleted successfully")
        router.push('/prompt-library')
      } else {
        toast.error(result?.message || "Failed to delete prompt")
      }
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    )
  }

  if (!promptData) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-destructive">Prompt not found</p>
      </div>
    )
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
              <h1 className="text-2xl font-semibold text-gray-900">Edit Prompt</h1>
              <p className="text-sm text-muted-foreground">
                Modify your prompt details and settings
              </p>
            </div>
          </div>

          <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
          <Button
            onClick={handleSave}
            disabled={isUpdating}
          >
            <Save className="mr-2 h-4 w-4" />
            {isUpdating ? 'Saving...' : 'Save Changes'}
          </Button>
          </div>
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
              value={formData.description || ''}
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
              value={formData.tags || []}
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

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 rounded-lg border p-4">
            <div>
              <div className="text-sm font-medium text-muted-foreground">
                Views
              </div>
              <div className="text-2xl font-semibold">
                {promptData.viewCount}
              </div>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">
                Uses
              </div>
              <div className="text-2xl font-semibold">
                {promptData.useCount}
              </div>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">
                Status
              </div>
              <div className="text-sm font-semibold capitalize">
                {promptData.moderationStatus}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
