import { Suspense } from "react"
import { SettingsClient } from "./_components/settings-client"
import { requireRole } from "@/lib/auth/role-helpers"
import { getSettingsAction, getBrandingLogoUrlAction } from "@/actions/db/settings-actions"
import { Skeleton } from "@/components/ui/skeleton"
import { PageBranding } from "@/components/ui/page-branding"
import { getNexusEnabledModels } from "@/lib/db/drizzle"
import { executeQuery } from "@/lib/db/drizzle-client"
import { nexusMcpServers } from "@/lib/db/schema"
import { hasCapability } from "@/lib/ai/capability-utils"
import { inferFamily } from "@/lib/nexus/model-router/router"

export default async function SettingsPage() {
  await requireRole("administrator")

  // Fetch settings, routing options, and current logo URL in parallel.
  const [settingsResult, logoResult, models, connectors] = await Promise.all([
    getSettingsAction(),
    getBrandingLogoUrlAction(),
    getNexusEnabledModels(),
    executeQuery(
      db => db.select({ id: nexusMcpServers.id, name: nexusMcpServers.name }).from(nexusMcpServers),
      "getNexusRouterAdminConnectors"
    ),
  ])
  const settings = settingsResult.isSuccess ? settingsResult.data : []
  const currentLogoUrl = (logoResult.isSuccess && logoResult.data) ? logoResult.data : "/logo.png"

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">System Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage API keys and configuration values for the application
        </p>
      </div>

      <Suspense fallback={<SettingsSkeleton />}>
        <SettingsClient
          initialSettings={settings}
          currentLogoUrl={currentLogoUrl}
          nexusRouterModels={models.map(model => ({
            id: model.id,
            name: model.name,
            provider: model.provider,
            modelId: model.modelId,
            family: inferFamily(model),
            imageGeneration: hasCapability(model.capabilities, "imageGeneration"),
            deepResearch: hasCapability(model.capabilities, "deepResearch"),
            webSearch: hasCapability(model.capabilities, "webSearch")
              || hasCapability(model.capabilities, "grounding"),
          }))}
          nexusRouterConnectors={connectors}
        />
      </Suspense>
    </div>
  )
}

function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      {/* Category skeleton */}
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}
