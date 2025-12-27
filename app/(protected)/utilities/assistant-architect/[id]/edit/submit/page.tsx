import { redirect, notFound } from "next/navigation"
import { getServerSession } from "@/lib/auth/server-session"
import { checkUserRoleByCognitoSub } from "@/lib/db/drizzle"
import { getAssistantArchitectAction } from "@/actions/db/assistant-architect-actions"
import { CreateLayout } from "../../../create/_components/create-layout"
import { SubmitForm } from "./_components/submit-form"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"

// Note: This is a Server Component (no "use server" needed)

interface Props {
  params: Promise<{
    id: string
  }>
}

export default async function SubmitAssistantArchitectPage({ params }: Props) {
  const resolvedParams = await params
  const id = resolvedParams.id
  
  const toolResult = await getAssistantArchitectAction(id)
  if (!toolResult.isSuccess) {
    notFound()
  }
  
  const tool = toolResult.data
  if (!tool) {
    notFound()
  }
  
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
    <CreateLayout currentStep={5} assistantId={id} title="Submit your assistant for Approval">
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
        <SubmitForm id={id} tool={tool} />
      </div>
    </CreateLayout>
  )
} 