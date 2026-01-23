import { redirect, notFound } from "next/navigation"
import { getAssistantArchitectAction } from "@/actions/db/assistant-architect-actions"
import { getArchitectModelsAction } from "@/actions/db/ai-models-actions"
import { getServerSession } from "@/lib/auth/server-session"
import { checkUserRoleByCognitoSub } from "@/lib/db/drizzle"
import { CreateLayout } from "../../../create/_components/create-layout"
import { PromptsPageClient } from "./_components/prompts-page-client"
import Link from "next/link"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"

interface PromptsPageProps {
  params: Promise<{ id: string }>
}

const EDITABLE_STATUSES = ["draft", "pending_approval", "rejected", "approved"]

function canUserEdit(
  isAdmin: boolean,
  isCreator: boolean,
  status: string | null
): boolean {
  if (isAdmin) return true
  if (!isCreator) return false
  return status !== null && EDITABLE_STATUSES.includes(status)
}

export default async function PromptsPage({ params }: PromptsPageProps) {
  const { id } = await params

  const result = await getAssistantArchitectAction(id)
  if (!result.isSuccess || !result.data) {
    notFound()
  }

  const tool = result.data

  const session = await getServerSession()
  if (!session?.sub) {
    redirect("/sign-in")
  }

  const [isAdmin, currentUser, modelsResult] = await Promise.all([
    checkUserRoleByCognitoSub(session.sub, "administrator"),
    getCurrentUserAction(),
    getArchitectModelsAction()
  ])

  const isCreator = currentUser.isSuccess && currentUser.data?.user.id === tool.userId

  if (!canUserEdit(isAdmin, isCreator, tool.status)) {
    redirect(`/utilities/assistant-architect/${id}`)
  }

  const models = modelsResult.isSuccess ? modelsResult.data : []
  const sortedPrompts = tool.prompts?.slice().sort((a, b) => a.position - b.position) ?? []
  const sortedInputFields = tool.inputFields?.slice().sort((a, b) => a.position - b.position) ?? []

  return (
    <CreateLayout currentStep={2} assistantId={id} title="Add Prompts">
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
          Add and manage prompts that define how your assistant processes inputs and generates responses.
        </p>
        <PromptsPageClient
          assistantId={id}
          prompts={sortedPrompts}
          models={models}
          inputFields={sortedInputFields}
        />
      </div>
      <div className="flex justify-end mt-8">
        <Link href={`/utilities/assistant-architect/${id}/edit/preview`}>
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
