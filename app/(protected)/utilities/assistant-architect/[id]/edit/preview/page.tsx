import { getAssistantArchitectByIdAction } from "@/actions/db/assistant-architect-actions"
import { PreviewSubmitClient } from "./_components/preview-submit-client"
import { CreateLayout } from "../../../create/_components/create-layout"
import { redirect, notFound } from "next/navigation"
import { getServerSession } from "@/lib/auth/server-session"
import { checkUserRoleByCognitoSub } from "@/lib/db/drizzle"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"

interface PreviewPageProps {
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

export default async function PreviewPage({ params }: PreviewPageProps) {
  const { id } = await params

  const result = await getAssistantArchitectByIdAction(id)
  if (!result.isSuccess || !result.data) {
    notFound()
  }

  const tool = result.data

  const session = await getServerSession()
  if (!session?.sub) {
    redirect("/sign-in")
  }

  const [isAdmin, currentUser] = await Promise.all([
    checkUserRoleByCognitoSub(session.sub, "administrator"),
    getCurrentUserAction()
  ])

  const isCreator = currentUser.isSuccess && currentUser.data?.user.id === tool.userId

  if (!canUserEdit(isAdmin, isCreator, tool.status)) {
    redirect(`/utilities/assistant-architect/${id}`)
  }

  const toolForPreview = Object.assign({}, tool, {
    inputFields: tool.inputFields ?? [],
    prompts: tool.prompts ?? []
  })

  return (
    <CreateLayout currentStep={3} assistantId={id} title="Preview & Submit">
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
          Test your assistant and submit for approval when ready.
        </p>

        <PreviewSubmitClient assistantId={id} tool={toolForPreview} />
      </div>
    </CreateLayout>
  )
}
