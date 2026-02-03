import { Suspense } from "react"
import { requireRole } from "@/lib/auth/role-helpers"
import { getAIModels } from "@/lib/db/drizzle"
import { ModelsPageClient } from "./_components"
import { StatsCardsSkeleton } from "./_components/stats-cards"
import { PageBranding } from "@/components/ui/page-branding"
import type { SelectAiModel } from "@/types/db-types"

export default async function ModelsPage() {
  await requireRole("administrator")

  // Fetch AI models from the database
  const models = await getAIModels()

  return (
    <Suspense
      fallback={
        <div className="p-6 space-y-6">
          <div className="mb-6">
            <PageBranding />
            <h1 className="text-2xl font-semibold text-gray-900">AI Models Management</h1>
            <p className="text-sm text-muted-foreground mt-1">Loading...</p>
          </div>
          <StatsCardsSkeleton />
        </div>
      }
    >
      <ModelsPageClient initialModels={(models as SelectAiModel[]) || []} />
    </Suspense>
  )
} 