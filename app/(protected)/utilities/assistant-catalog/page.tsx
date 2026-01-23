import { redirect } from "next/navigation"
import { getServerSession } from "@/lib/auth/server-session"
import { getAssistantCatalogAction } from "@/actions/assistant-catalog.actions"
import { AssistantCatalogClient } from "./_components/assistant-catalog-client"
import { PageBranding } from "@/components/ui/page-branding"

export default async function AssistantCatalogPage() {
  // Get current user session
  const session = await getServerSession()
  if (!session || !session.sub) {
    redirect("/sign-in")
  }

  // Get catalog data
  const result = await getAssistantCatalogAction()
  if (!result.isSuccess) {
    throw new Error(result.message)
  }

  const assistants = result.data

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <PageBranding />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Assistant Catalog</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Discover and launch specialized AI assistants
          </p>
        </div>
      </div>

      <AssistantCatalogClient initialAssistants={assistants} />
    </div>
  )
}
