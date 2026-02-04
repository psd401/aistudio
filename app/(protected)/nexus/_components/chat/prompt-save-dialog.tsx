"use client"

import { useState, useEffect, startTransition } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from "@/components/ui/dialog"
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
import { TagInput } from "@/components/ui/tag-input"
import { usePromptSave } from "../hooks/use-prompt-save"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { PromptVisibility } from "@/lib/prompt-library/types"

interface PromptSaveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  content: string
  conversationId: string | null
}

/**
 * Dialog for saving a prompt with full metadata
 */
export function PromptSaveDialog({
  open,
  onOpenChange,
  content,
  conversationId
}: PromptSaveDialogProps) {
  // Generate default title from content (first 100 chars)
  const defaultTitle = content.slice(0, 100).trim() || "Untitled Prompt"

  const [title, setTitle] = useState(defaultTitle)
  const [description, setDescription] = useState("")
  const [visibility, setVisibility] = useState<PromptVisibility>("private")
  const [tags, setTags] = useState<string[]>([])
  const { savePrompt, isSaving } = usePromptSave()

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (open) {
      startTransition(() => {
        setTitle(defaultTitle)
        setDescription("")
        setVisibility("private")
        setTags([])
      })
    }
  }, [open, defaultTitle])

  const handleSave = async () => {
    const result = await savePrompt({
      title: title.trim() || defaultTitle,
      content,
      description: description.trim() || undefined,
      visibility,
      tags: tags.length > 0 ? tags : undefined,
      sourceConversationId: conversationId || undefined
    })

    if (result.success) {
      onOpenChange(false)
    }
  }

  const isValid = title.trim().length > 0 && title.length <= 255

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Save Prompt to Library</DialogTitle>
          <DialogDescription>
            Save this message as a reusable prompt in your library
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-4">
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter a descriptive title"
                maxLength={255}
                required
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{isValid ? "" : "Title is required"}</span>
                <span>
                  {title.length}/255
                </span>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this prompt do?"
                rows={3}
                maxLength={1000}
              />
              <div className="text-xs text-muted-foreground text-right">
                {description.length}/1000
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="visibility">Visibility</Label>
              <Select
                value={visibility}
                onValueChange={(value) => setVisibility(value as PromptVisibility)}
              >
                <SelectTrigger id="visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">
                    <div className="flex flex-col items-start">
                      <span className="font-medium">Private</span>
                      <span className="text-xs text-muted-foreground">
                        Only you can see this prompt
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="public">
                    <div className="flex flex-col items-start">
                      <span className="font-medium">Public</span>
                      <span className="text-xs text-muted-foreground">
                        Share with the community (requires approval)
                      </span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="tags">Tags (optional)</Label>
              <TagInput
                id="tags"
                value={tags}
                onChange={setTags}
                placeholder="Add tags (press Enter)"
                maxTags={10}
              />
              <div className="text-xs text-muted-foreground">
                Add up to 10 tags to help organize and find this prompt
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">
                Prompt Preview
              </Label>
              <div className="rounded-md bg-muted p-3 max-h-32 overflow-auto">
                <pre className="text-sm whitespace-pre-wrap break-words">
                  {content.slice(0, 500)}
                  {content.length > 500 && "..."}
                </pre>
              </div>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !isValid}>
            {isSaving ? "Saving..." : "Save Prompt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
