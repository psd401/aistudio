"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AssistantArchitectStreaming } from "@/components/features/assistant-architect/assistant-architect-streaming"
import { Button } from "@/components/ui/button"
import { submitAssistantArchitectForApprovalAction } from "@/actions/db/assistant-architect-actions"
import { toast } from "sonner"
import { AlertCircle, CheckCircle2 } from "lucide-react"
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
    try {
      setIsLoading(true)
      const result = await submitAssistantArchitectForApprovalAction(assistantId)

      if (result.isSuccess) {
        toast.success("Assistant submitted for approval")
        router.push(`/utilities/assistant-architect`)
      } else {
        toast.error(result.message)
      }
    } catch {
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
      isComplete: tool.prompts.length > 0
    }
  ]

  const allRequirementsMet = requirements.every(req => req.isComplete)

  return (
    <div className="space-y-8">
      {/* Test Your Assistant Section */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">Test Your Assistant</h3>
          <p className="text-sm text-muted-foreground">
            Try your assistant with the configured prompts to verify it works as expected.
          </p>
        </div>
        <div className="border rounded-lg p-4">
          <AssistantArchitectStreaming tool={tool} />
        </div>
      </div>

      {/* Readiness Checklist + Submit Section */}
      <div className="border-t pt-6 space-y-4">
        <div>
          <h3 className="text-lg font-medium">Readiness Checklist</h3>
          <p className="text-sm text-muted-foreground">
            Verify all required components are complete before submitting.
          </p>
        </div>

        <div className="flex flex-wrap gap-4">
          {requirements.map((req) => (
            <RequirementItem
              key={req.title}
              title={req.title}
              isComplete={req.isComplete}
            />
          ))}
        </div>

        <div className="flex justify-end pt-2">
          <Button
            onClick={handleSubmit}
            disabled={isLoading || !allRequirementsMet}
          >
            {isLoading ? "Submitting..." : "Submit for Approval"}
          </Button>
        </div>
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
