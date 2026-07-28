import {
  getNexusChatPreferences,
  getUserProfile,
  listUserApiKeys,
} from "@/actions/settings/user-settings.actions"
import { listNexusMemories } from "@/actions/nexus/memory.actions"
import { PageBranding } from "@/components/ui/page-branding"
import { hasCapabilityAccess } from "@/utils/roles"
import { SettingsClient } from "./_components/settings-client"

export const metadata = {
  title: "Settings | AI Studio",
}

export default async function SettingsPage() {
  const hasMemoryCapability = await hasCapabilityAccess("nexus-memory")
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
          memoryResult?.isSuccess
            ? memoryResult.data
            : {
                memories: [],
                memoryEnabled: true,
                globalMemoryEnabled: false,
                nextCursor: null,
              }
        }
      />
    </div>
  )
}
