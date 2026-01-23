import { getAssistantArchitectAction } from "@/actions/db/assistant-architect-actions"
import { AssistantArchitectStreaming } from "@/components/features/assistant-architect/assistant-architect-streaming"
import { Card, CardContent } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { PageBranding } from "@/components/ui/page-branding"
import { Terminal, ArrowLeft } from "lucide-react"
import { AssistantArchitectWithRelations } from "@/types"
import Link from "next/link"

/**
 * Public route for executing approved Assistant Architect tools.
 * This is the route that users will access through the navigation menu.
 * 
 * The route will:
 * 1. Only show approved tools (404 for non-approved tools)
 * 2. Show a simplified interface focused on execution
 * 3. Remove administrative functions
 * 
 * URL Pattern: /tools/assistant-architect/{id}
 * where {id} is the UUID of the Assistant Architect tool
 */

interface AssistantArchitectToolPageProps {
  params: Promise<{ id: string }>
}

export default async function AssistantArchitectToolPage({
  params
}: AssistantArchitectToolPageProps) {
  // Properly await params
  const resolvedParams = await params;
  const id = resolvedParams.id;
  
  const result = await getAssistantArchitectAction(id)
  
  if (
    !result.isSuccess ||
    !result.data ||
    result.data.status !== "approved"
  ) {
    return (
      <div className="container mx-auto py-12">
        <Alert variant="destructive">
          <Terminal className="h-4 w-4" />
          <AlertTitle>Access Denied</AlertTitle>
          <AlertDescription>
            Assistant Architect not found, not approved, or you do not have access.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const tool = result.data as AssistantArchitectWithRelations

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="mb-6">
        <PageBranding />
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            asChild
          >
            <Link href="/utilities/assistant-catalog">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Run Assistant</h1>
            <p className="text-sm text-muted-foreground">
              Execute an AI assistant from the catalog
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="pt-1.5">
          <AssistantArchitectStreaming tool={tool} />
        </CardContent>
      </Card>
    </div>
  )
} 