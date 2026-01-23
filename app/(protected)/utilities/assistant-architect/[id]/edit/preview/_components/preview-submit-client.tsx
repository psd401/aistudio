"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AssistantArchitectStreaming } from "@/components/features/assistant-architect/assistant-architect-streaming"
import { Button } from "@/components/ui/button"
import { submitAssistantArchitectForApprovalAction } from "@/actions/db/assistant-architect-actions"
import { toast } from "sonner"
import { AlertCircle, CheckCircle2 } from "lucide-react"
import { createLogger, generateRequestId } from "@/lib/client-logger"
import type { AssistantArchitectWithRelations } from "@/types/assistant-architect-types"

interface PreviewSubmitClientProps {
  assistantId: string
  tool: AssistantArchitectWithRelations
}

export function PreviewSubmitClient({
  assistantId,
  tool
}: PreviewSubmitClientProps) {
  const [isLoading, setIsLoading] = useState(false)
  const router = useRouter()

  const handleSubmit = async () => {
    const requestId = generateRequestId()
    const log = createLogger({ requestId, component: "PreviewSubmitClient" })

    try {
      log.info("Submitting assistant for approval", { assistantId })
      setIsLoading(true)
      const result = await submitAssistantArchitectForApprovalAction(assistantId)

      if (result.isSuccess) {
        log.info("Assistant submitted successfully", { assistantId })
        toast.success("Assistant submitted for approval")
        router.push(`/utilities/assistant-architect`)
      } else {
        log.warn("Assistant submission failed", { assistantId, message: result.message })
        toast.error(result.message)
      }
    } catch (error) {
      log.error("Failed to submit assistant", { assistantId, error })
      toast.error("Failed to submit assistant")
    } finally {
      setIsLoading(false)
    }
  }

  const requirements = [
    {
      title: "Name",
      isComplete: !!tool.name
    },
    {
      title: "Description",
      isComplete: !!tool.description
    },
    {
      title: "Prompts",
      isComplete: (tool.prompts?.length ?? 0) > 0
    }
  ]

  const allRequirementsMet = requirements.every(req => req.isComplete)

  return (
    <div className="space-y-6">
      {/* Assistant Testing Interface */}
      <div className="border rounded-lg p-4">
        <AssistantArchitectStreaming tool={tool} />
      </div>

      {/* Submit Section */}
      <div className="border-t pt-6 flex items-center justify-between">
        <div className="flex flex-wrap gap-4">
          {requirements.map((req) => (
            <RequirementItem
              key={req.title}
              title={req.title}
              isComplete={req.isComplete}
            />
          ))}
        </div>

        <Button
          onClick={handleSubmit}
          disabled={isLoading || !allRequirementsMet}
        >
          {isLoading ? "Submitting..." : "Submit for Approval"}
        </Button>
      </div>
    </div>
  )
}

interface RequirementItemProps {
  title: string
  isComplete: boolean
}

function RequirementItem({ title, isComplete }: RequirementItemProps) {
  return (
    <div className="flex items-center gap-2">
      {isComplete ? (
        <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
      ) : (
        <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
      )}
      <span className="font-medium">{title}</span>
    </div>
  )
}
