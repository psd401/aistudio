"use client"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Play, MoreVertical, Edit, Trash2, Eye } from "lucide-react"
import { useRouter } from "next/navigation"
import { usePromptLibraryStore } from "@/lib/stores/prompt-library-store"
import { deletePrompt } from "@/actions/prompt-library.actions"
import { useAction } from "@/lib/hooks/use-action"
import { toast } from "sonner"
import type { PromptListItem as PromptListItemType } from "@/lib/prompt-library/types"
import { format } from "date-fns"
import { meridianPortalClassName } from "@/lib/meridian/fonts"

interface PromptListItemProps {
  prompt: PromptListItemType
  onDelete?: () => void
}

export function PromptListItem({ prompt, onDelete }: PromptListItemProps) {
  const router = useRouter()
  const { selectedPrompts, toggleSelection } = usePromptLibraryStore()

  const isSelected = selectedPrompts.has(prompt.id)

  const { execute: executeDelete } = useAction(deletePrompt)

  const handleLaunch = () => {
    router.push(`/nexus?promptId=${prompt.id}`)
  }

  const handleEdit = () => {
    router.push(`/prompt-library/${prompt.id}`)
  }

  const handleDelete = async () => {
    if (confirm("Are you sure you want to delete this prompt?")) {
      const result = await executeDelete(prompt.id)
      if (result?.isSuccess) {
        toast.success("Prompt deleted successfully")
        onDelete?.()
      } else {
        toast.error(result?.message || "Failed to delete prompt")
      }
    }
  }

  return (
    <div
      className={`group flex items-center gap-4 rounded-lg border p-4 transition-all hover:bg-accent ${
        isSelected ? 'border-primary bg-accent' : ''
      }`}
    >
      {/* Selection */}
      <Checkbox
        checked={isSelected}
        onCheckedChange={() => toggleSelection(prompt.id)}
      />

      {/* Content */}
      <div className="flex-1 space-y-1">
        <div className="flex items-start gap-2">
          <h3 className="font-semibold">{prompt.title}</h3>
          {prompt.visibility === 'public' && (
            <Badge variant="secondary" className="text-xs">
              Public
            </Badge>
          )}
        </div>

        <p className="line-clamp-2 text-sm text-muted-foreground">
          {prompt.description || prompt.preview}
        </p>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Eye className="h-3 w-3" />
            {prompt.viewCount}
          </span>
          <span className="flex items-center gap-1">
            <Play className="h-3 w-3" />
            {prompt.useCount}
          </span>
          <span>{format(new Date(prompt.createdAt), 'MMM d, yyyy')}</span>
          {prompt.tags && prompt.tags.length > 0 && (
            <div className="flex gap-1">
              {prompt.tags.slice(0, 2).map((tag) => (
                <Badge key={tag} variant="outline" className="text-xs">
                  {tag}
                </Badge>
              ))}
              {prompt.tags.length > 2 && (
                <span className="text-xs">+{prompt.tags.length - 2}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button onClick={handleLaunch}>
          <Play className="mr-2 h-4 w-4" />
          Use
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={meridianPortalClassName}>
            <DropdownMenuItem onClick={handleEdit}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleLaunch}>
              <Play className="mr-2 h-4 w-4" />
              Use in Chat
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onClick={handleDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
