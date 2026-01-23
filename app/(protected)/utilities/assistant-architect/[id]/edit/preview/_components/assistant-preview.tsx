"use client"

import { AssistantArchitectStreaming } from "@/components/features/assistant-architect/assistant-architect-streaming"
import type { AssistantArchitectWithRelations } from "@/types/assistant-architect-types"

interface AssistantPreviewProps {
  assistantId: string
  tool: AssistantArchitectWithRelations
}

/**
 * Standalone assistant preview component for testing/previewing an assistant.
 * Used by both the preview-submit page and the approval dialog.
 */
export function AssistantPreview({
  tool
}: AssistantPreviewProps) {
  return (
    <div className="space-y-4">
      <div className="border rounded-lg p-4 space-y-4">
        <AssistantArchitectStreaming tool={tool} />
      </div>
    </div>
  )
}
