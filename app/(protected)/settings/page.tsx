import {
  getNexusChatPreferences,
  getUserProfile,
  listUserApiKeys,
} from "@/actions/settings/user-settings.actions"
import { listNexusMemories } from "@/actions/nexus/memory.actions"
import { PageBranding } from "@/components/ui/page-branding"
import { createLogger } from "@/lib/logger"
import { hasCapabilityAccess } from "@/utils/roles"
import { SettingsClient } from "./_components/settings-client"

export const metadata = {
  title: "Settings | AI Studio",
}

const log = createLogger({ moduleName: "settings-page" })

async function resolveMemoryCapability(): Promise<boolean> {
  try {
    return await hasCapabilityAccess("nexus-memory")
  } catch (error) {
    log.error("Failed to resolve Nexus memory capability", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export default async function SettingsPage() {
  const hasMemoryCapability = await resolveMemoryCapability()
  const [profileResult, keysResult, preferencesResult, memoryResult] =
    await Promise.all([
      getUserProfile(),
      listUserApiKeys(),
      getNexusChatPreferences(),
      hasMemoryCapability ? listNexusMemories() : Promise.resolve(null),
    ])

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your profile, API keys, and preferences
        </p>
      </div>

      <SettingsClient
        profileData={profileResult.isSuccess ? profileResult.data : null}
        apiKeys={keysResult.isSuccess ? keysResult.data : []}
        nexusPreferences={
          preferencesResult.isSuccess
            ? preferencesResult.data
            : { mode: "standard", family: "auto" }
        }
        hasMemoryCapability={hasMemoryCapability}
        memoryData={
          memoryResult?.isSuccess ? memoryResult.data : null
        }
        memoryLoadError={
          memoryResult && !memoryResult.isSuccess
            ? memoryResult.message
            : null
        }
      />
    </div>
  )
}
