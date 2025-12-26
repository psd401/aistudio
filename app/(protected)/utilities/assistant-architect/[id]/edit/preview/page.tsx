import { getAssistantArchitectByIdAction } from "@/actions/db/assistant-architect-actions"
import { PreviewPageClient } from "./_components/preview-page-client"
import { CreateLayout } from "../../../create/_components/create-layout"
import { redirect, notFound } from "next/navigation"
import { getServerSession } from "@/lib/auth/server-session"
import { checkUserRoleByCognitoSub } from "@/lib/db/drizzle"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"

interface PreviewPageProps {
  params: Promise<{ id: string }>
}

export default async function PreviewPage({ params }: PreviewPageProps) {
  // Properly await params
  const resolvedParams = await params
  const id = resolvedParams.id
  
  const result = await getAssistantArchitectByIdAction(id)
  if (!result.isSuccess || !result.data) {
    notFound()
  }

  const tool = result.data
  
  // Check authentication
  const session = await getServerSession()
  if (!session || !session.sub) {
    redirect("/sign-in")
  }

  const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
  const currentUser = await getCurrentUserAction()
  const isCreator = currentUser.isSuccess && currentUser.data?.user.id === tool.userId
  const canEdit = isAdmin || (isCreator && (tool.status === "draft" || tool.status === "pending_approval" || tool.status === "rejected" || tool.status === "approved"))

  if (!canEdit) {
    redirect(`/utilities/assistant-architect/${id}`)
  }

  return (
    <CreateLayout currentStep={4} assistantId={id} title="Preview & Test">
      <div className="space-y-6">
        {tool.status === "approved" && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-800">
            <p className="text-sm">
              <strong>Note:</strong> This assistant is currently approved and in use. 
              Any changes you make will require re-approval, and the assistant will be unavailable 
              until approved again.
            </p>
          </div>
        )}
        <p className="text-muted-foreground">
          Test your assistant with the configured input fields and prompts.
        </p>

        <PreviewPageClient
          assistantId={id}
          tool={{...tool, inputFields: tool.inputFields || [], prompts: tool.prompts || []}}
        />
      </div>

      <div className="flex justify-end mt-8">
        <a href={`/utilities/assistant-architect/${id}/edit/submit`}>
          <button
            type="button"
            className="inline-flex items-center px-4 py-2 bg-primary text-primary-foreground rounded-md shadow-sm hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
          >
            Continue
          </button>
        </a>
      </div>
    </CreateLayout>
  )
} 