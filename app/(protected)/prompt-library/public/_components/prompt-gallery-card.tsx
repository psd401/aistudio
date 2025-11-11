"use client"

import { useState } from "react"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { PlayIcon, EyeIcon, CopyIcon, BrainCircuit } from "lucide-react"
import { PromptPreviewModal } from "./prompt-preview-modal"
import type { PromptListItem } from "@/lib/prompt-library/types"
import { formatDistanceToNow } from "date-fns"
import { useRouter } from "next/navigation"
import { trackPromptUse } from "@/actions/prompt-library.actions"

interface PromptGalleryCardProps {
  prompt: PromptListItem
}

export function PromptGalleryCard({ prompt }: PromptGalleryCardProps) {
  const router = useRouter()
  const [showPreview, setShowPreview] = useState(false)

  const handleUsePrompt = async () => {
    // Track usage asynchronously (silently fail if tracking fails)
    trackPromptUse(prompt.id).catch(() => {
      // Tracking is non-critical, continue with navigation
    })

    // Navigate to Nexus chat with the prompt pre-loaded
    router.push(`/nexus?promptId=${prompt.id}`)
  }

  const handleViewDetails = () => {
    setShowPreview(true)
  }

  return (
    <>
      <Card className="group hover:shadow-xl transition-all duration-300 hover:-translate-y-1 flex flex-col h-full">
        <CardHeader className="pb-3 flex-none">
          <div className="flex items-start gap-3">
            {/* Icon */}
            <div className="flex-shrink-0 mt-0.5">
              <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
                <BrainCircuit className="h-6 w-6 text-primary" />
              </div>
            </div>

            {/* Title */}
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-lg line-clamp-2">
                {prompt.title}
              </h3>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pb-3 flex-grow flex flex-col gap-3">
          {/* Description */}
          <p className="text-sm text-muted-foreground line-clamp-3">
            {prompt.description || prompt.preview}
          </p>

          {/* Tags - Always show tag area */}
          <div className="flex flex-wrap gap-1 min-h-[24px]">
            {prompt.tags && prompt.tags.length > 0 ? (
              <>
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
              </>
            ) : (
              <span className="text-xs text-muted-foreground/50">No tags</span>
            )}
          </div>

          {/* Stats */}
          <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <CopyIcon className="h-3 w-3" />
                {prompt.useCount}
              </span>
              <span className="flex items-center gap-1">
                <EyeIcon className="h-3 w-3" />
                {prompt.viewCount}
              </span>
            </div>
            <span>
              {formatDistanceToNow(new Date(prompt.createdAt), {
                addSuffix: true
              })}
            </span>
          </div>
        </CardContent>

        <CardFooter className="pt-3 border-t flex-none">
          <div className="flex items-center gap-2 w-full">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handleViewDetails}
            >
              <EyeIcon className="mr-1 h-3 w-3" />
              Preview
            </Button>
            <Button size="sm" className="flex-1" onClick={handleUsePrompt}>
              <PlayIcon className="mr-1 h-3 w-3" />
              Use
            </Button>
          </div>
        </CardFooter>
      </Card>

      <PromptPreviewModal
        open={showPreview}
        onOpenChange={setShowPreview}
        promptId={prompt.id}
        onUse={handleUsePrompt}
      />
    </>
  )
}
