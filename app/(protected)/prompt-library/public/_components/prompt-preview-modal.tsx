"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { PlayIcon, CopyIcon, Loader2Icon } from "lucide-react"
import { toast } from "sonner"
import {
  getPrompt,
  trackPromptView
} from "@/actions/prompt-library.actions"
import type { Prompt } from "@/lib/prompt-library/types"
import { formatDistanceToNow } from "date-fns"

interface PromptPreviewModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  promptId: string
  onUse: () => void
}

function getInitials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0)
      .map((part) => part[0])
      .join("")
      .toUpperCase()
      .slice(0, 2) || "??"
  )
}

function PromptPreviewBody({
  prompt,
  onCopy,
  onUse,
}: {
  prompt: Prompt
  onCopy: () => void
  onUse: () => void
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-xl pr-8">{prompt.title}</DialogTitle>
        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Avatar className="h-6 w-6">
              <AvatarFallback className="text-xs">
                {getInitials(prompt.ownerName || "Unknown")}
              </AvatarFallback>
            </Avatar>
            <span>{prompt.ownerName || "Anonymous"}</span>
            <span>·</span>
            <span>
              {formatDistanceToNow(new Date(prompt.createdAt), {
                addSuffix: true
              })}
            </span>
          </div>
        </div>
      </DialogHeader>

      <Tabs defaultValue="prompt" className="flex-1 flex flex-col min-h-0">
        <TabsList>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        <TabsContent
          value="prompt"
          className="flex-1 min-h-0 mt-4 data-[state=active]:flex data-[state=active]:flex-col"
        >
          <ScrollArea className="flex-1 rounded-md border p-4">
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
              {prompt.content}
            </pre>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="details" className="mt-4 space-y-4">
          <ScrollArea className="max-h-[400px]">
            <div className="space-y-4 pr-4">
              {prompt.description && (
                <div>
                  <h4 className="font-medium mb-2">Description</h4>
                  <p className="text-sm text-muted-foreground">
                    {prompt.description}
                  </p>
                </div>
              )}
              {prompt.tags && prompt.tags.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">Tags</h4>
                  <div className="flex flex-wrap gap-2">
                    {prompt.tags.map((tag) => (
                      <Badge key={tag} variant="outline">{tag}</Badge>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <h4 className="font-medium mb-2">Statistics</h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="space-y-1">
                    <span className="text-muted-foreground">Uses</span>
                    <p className="font-semibold text-lg">{prompt.useCount}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-muted-foreground">Views</span>
                    <p className="font-semibold text-lg">{prompt.viewCount}</p>
                  </div>
                </div>
              </div>
              <div>
                <h4 className="font-medium mb-2">Visibility</h4>
                <Badge
                  variant={
                    prompt.visibility === "public" ? "default" : "secondary"
                  }
                >
                  {prompt.visibility}
                </Badge>
              </div>
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>

      <DialogFooter className="flex-none">
        <Button variant="outline" onClick={onCopy}>
          <CopyIcon className="mr-2 h-4 w-4" />
          Copy
        </Button>
        <Button onClick={onUse}>
          <PlayIcon className="mr-2 h-4 w-4" />
          Use Prompt
        </Button>
      </DialogFooter>
    </>
  )
}

export function PromptPreviewModal({
  open,
  onOpenChange,
  promptId,
  onUse
}: PromptPreviewModalProps) {
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let mounted = true

    const loadPrompt = async () => {
      if (!mounted) return

      setLoading(true)
      const result = await getPrompt(promptId)

      if (!mounted) return

      if (result.isSuccess) {
        setPrompt(result.data)
        // Track view asynchronously (silently fail if tracking fails)
        trackPromptView(promptId).catch(() => {
          // Tracking is non-critical, continue showing prompt
        })
      } else {
        toast.error(result.message || "Failed to load prompt")
        onOpenChange(false)
      }

      setLoading(false)
    }

    if (open && promptId) {
      loadPrompt()
    }

    return () => {
      mounted = false
    }
  }, [open, promptId, onOpenChange])

  const handleCopy = async () => {
    if (!prompt) return

    try {
      await navigator.clipboard.writeText(prompt.content)
      toast.success("Copied to clipboard")
    } catch {
      toast.error("Failed to copy to clipboard")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        {loading || !prompt ? (
          <div className="flex items-center justify-center py-12">
            <Loader2Icon className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <PromptPreviewBody
            prompt={prompt}
            onCopy={handleCopy}
            onUse={onUse}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
