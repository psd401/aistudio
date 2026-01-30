import { Suspense } from "react"
import { requireRole } from "@/lib/auth/role-helpers"
import { GraphPageClient } from "./_components"
import { PageBranding } from "@/components/ui/page-branding"

export default async function AdminGraphPage() {
  await requireRole("administrator")

  return (
    <Suspense
      fallback={
        <div className="p-6 space-y-6">
          <div className="mb-6">
            <PageBranding />
            <h1 className="text-2xl font-semibold text-gray-900">
              Context Graph
            </h1>
            <p className="text-sm text-muted-foreground mt-1">Loading...</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-24 bg-muted rounded-lg animate-pulse"
              />
            ))}
          </div>
        </div>
      }
    >
      <GraphPageClient />
    </Suspense>
  )
}
