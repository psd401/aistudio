"use client"

import { useState, useCallback } from "react"
import { BookmarkIcon } from "lucide-react"
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button"
import { PromptSaveDialog } from "./prompt-save-dialog"
import { usePromptSave } from "../hooks/use-prompt-save"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import Link from "next/link"

interface PromptSaveButtonProps {
  content: string
  conversationId: string | null
  className?: string
  currentModelId?: string
  currentTools?: string[]
  currentConnectors?: string[]
}

/**
 * Button to save a prompt to the library
 * Can be used for quick save or open full dialog
 */
export function PromptSaveButton({
  content,
  conversationId,
  className = "",
  currentModelId,
  currentTools,
  currentConnectors
}: PromptSaveButtonProps) {
  const [showDialog, setShowDialog] = useState(false)
  const { savePrompt, isSaving } = usePromptSave()
  const { toast } = useToast()

  // Quick save with minimal metadata
  const handleQuickSave = useCallback(async () => {
    // Generate title from first 100 characters
    const title = content.slice(0, 100).trim()

    const result = await savePrompt({
      title: title || "Untitled Prompt",
      content,
      visibility: "private",
      sourceConversationId: conversationId || undefined
    })

    if (result.success && result.data) {
      toast({
        title: "Prompt saved",
        description: "Added to your prompt library",
        action: (
          <Button variant="outline" size="sm" asChild>
            <Link href="/prompt-library">View Library</Link>
          </Button>
        )
      })
    }
  }, [content, conversationId, savePrompt, toast])

  return (
    <>
      <TooltipIconButton
        tooltip="Save to library (Ctrl+S)"
        onClick={handleQuickSave}
        disabled={isSaving}
        className={className}
      >
        <BookmarkIcon />
      </TooltipIconButton>

      <PromptSaveDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        content={content}
        conversationId={conversationId}
        currentModelId={currentModelId}
        currentTools={currentTools}
        currentConnectors={currentConnectors}
      />
    </>
  )
}
