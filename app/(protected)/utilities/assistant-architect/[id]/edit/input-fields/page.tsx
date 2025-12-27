import { redirect, notFound } from "next/navigation"
import { getAssistantArchitectAction } from "@/actions/db/assistant-architect-actions"
import { getServerSession } from "@/lib/auth/server-session"
import { checkUserRoleByCognitoSub } from "@/lib/db/drizzle"
import { CreateLayout } from "../../../create/_components/create-layout"
import { InputFieldsPageClient } from "./_components/input-fields-page-client"
import Link from "next/link"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"

export default async function InputFieldsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getAssistantArchitectAction(id)
  if (!result.isSuccess) {
    notFound()
  }
  const tool = result.data
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
  const sortedInputFields = tool.inputFields?.slice().sort((a, b) => a.position - b.position) || []
  return (
    <CreateLayout currentStep={2} assistantId={id} title="Add Input Fields">
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
          Add and manage input fields that your assistant will use.
        </p>
        <InputFieldsPageClient assistantId={id} inputFields={sortedInputFields} />
      </div>
      <div className="flex justify-end mt-8">
        <Link href={`/utilities/assistant-architect/${id}/edit/prompts`}>
          <button
            type="button"
            className="inline-flex items-center px-4 py-2 bg-primary text-primary-foreground rounded-md shadow-sm hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
          >
            Continue
          </button>
        </Link>
      </div>
    </CreateLayout>
  )
}