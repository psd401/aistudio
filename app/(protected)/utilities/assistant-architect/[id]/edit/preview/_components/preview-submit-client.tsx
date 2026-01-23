"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AssistantArchitectStreaming } from "@/components/features/assistant-architect/assistant-architect-streaming"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
      isComplete: !!tool.name,
      description: "A descriptive name for your assistant"
    },
    {
      title: "Description",
      isComplete: !!tool.description,
      description: "A clear description of what your assistant does"
    },
    {
      title: "Prompts",
      isComplete: tool.prompts.length > 0,
      description: "At least one prompt configured"
    }
  ]

  const allRequirementsMet = requirements.every(req => req.isComplete)

  return (
    <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
      {/* Left Column: Assistant Preview (60%) */}
      <div className="xl:col-span-3 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Test Your Assistant</CardTitle>
            <CardDescription>
              Try your assistant with the configured prompts to verify it works as expected.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border rounded-lg p-4">
              <AssistantArchitectStreaming tool={tool} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Right Column: Readiness Checklist + Submit (40%) */}
      <div className="xl:col-span-2">
        <div className="xl:sticky xl:top-4 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Readiness Checklist</CardTitle>
              <CardDescription>
                Verify all required components are complete before submitting
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="font-medium">Required Components</div>
                <div className="space-y-1">
                  {requirements.map((req) => (
                    <RequirementItem
                      key={req.title}
                      title={req.title}
                      isComplete={req.isComplete}
                      description={req.description}
                    />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button
              onClick={handleSubmit}
              disabled={isLoading || !allRequirementsMet}
              size="lg"
              className="min-w-48"
            >
              {isLoading ? "Submitting..." : "Submit for Approval"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface RequirementItemProps {
  title: string
  isComplete: boolean
  description: string
}

function RequirementItem({ title, isComplete, description }: RequirementItemProps) {
  return (
    <div className="flex items-start gap-2">
      {isComplete ? (
        <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
      ) : (
        <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
      )}
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
    </div>
  )
}
