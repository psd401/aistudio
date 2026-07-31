"use client"

import { useState } from "react"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  Play,
  MoreVertical,
  Edit,
  Trash2,
  Eye
} from "lucide-react"
import { useRouter } from "next/navigation"
import { usePromptLibraryStore } from "@/lib/stores/prompt-library-store"
import { deletePrompt } from "@/actions/prompt-library.actions"
import { useAction } from "@/lib/hooks/use-action"
import { toast } from "sonner"
import type { PromptListItem } from "@/lib/prompt-library/types"
import { format } from "date-fns"
import { meridianPortalClassName } from "@/lib/meridian/fonts"

interface PromptCardProps {
  prompt: PromptListItem
  onDelete?: () => void
}

export function PromptCard({ prompt, onDelete }: PromptCardProps) {
  const router = useRouter()
  const { selectedPrompts, toggleSelection } = usePromptLibraryStore()
  const [isHovered, setIsHovered] = useState(false)

  const isSelected = selectedPrompts.has(prompt.id)

  const { execute: executeDelete } = useAction(deletePrompt)

  const handleLaunch = () => {
    // Navigate to Nexus with this prompt
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
    <Card
      className="group relative transition-colors duration-150 hover:border-[var(--mer-ink-muted)]"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Selection checkbox */}
      <div
        className={`absolute left-2 top-2 z-10 transition-opacity ${
          isHovered || isSelected ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => toggleSelection(prompt.id)}
        />
      </div>

      {/* Visibility badge */}
      {prompt.visibility === 'public' && (
        <Badge className="absolute right-2 top-2" variant="secondary">
          Public
        </Badge>
      )}

      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <h3 className="line-clamp-2 font-semibold">{prompt.title}</h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
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
              <DropdownMenuItem
                className="text-destructive"
                onClick={handleDelete}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      <CardContent className="pb-3">
        <p className="line-clamp-3 text-sm text-muted-foreground">
          {prompt.description || prompt.preview}
        </p>

        {/* Tags */}
        {prompt.tags && prompt.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {prompt.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
            {prompt.tags.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{prompt.tags.length - 3}
              </Badge>
            )}
          </div>
        )}

        {/* Stats */}
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Eye className="h-3 w-3" />
            {prompt.viewCount}
          </span>
          <span className="flex items-center gap-1">
            <Play className="h-3 w-3" />
            {prompt.useCount}
          </span>
          <span>{format(new Date(prompt.createdAt), 'MMM d, yyyy')}</span>
        </div>
      </CardContent>

      <CardFooter>
        <Button className="w-full" onClick={handleLaunch}>
          <Play className="mr-2 h-4 w-4" />
          Use Prompt
        </Button>
      </CardFooter>
    </Card>
  )
}
