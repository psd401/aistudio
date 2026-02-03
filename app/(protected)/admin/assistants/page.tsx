import { Suspense } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AssistantsTable } from "./_components/assistants-table"
import { PageBranding } from "@/components/ui/page-branding"

export default async function AssistantsPage() {
  return (
    <div className="container mx-auto px-6 py-8">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">AI Assistants</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage AI assistants created with the Assistant Architect
        </p>
      </div>
      <Card>
        <CardContent className="pt-6">
          <Suspense fallback={<AssistantsTableSkeleton />}>
            <AssistantsTableContent />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  )
}

async function AssistantsTableContent() {
  return <AssistantsTable />
}

function AssistantsTableSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-10 w-[300px]" />
        <Skeleton className="h-10 w-[120px]" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  )
} 