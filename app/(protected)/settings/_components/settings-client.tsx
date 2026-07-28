"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProfileTab } from "./profile-tab"
import { ApiKeysTab } from "./api-keys-tab"
import { PreferencesTab } from "./preferences-tab"
import type { NexusChatPreferences, UserProfileData } from "@/actions/settings/user-settings.actions"
import type { NexusMemoryTabData } from "@/actions/nexus/memory.actions"
import type { ApiKeyInfo } from "@/lib/api-keys/key-service"
import { MemoryTab } from "./memory-tab"

interface SettingsClientProps {
  profileData: UserProfileData | null
  apiKeys: ApiKeyInfo[]
  nexusPreferences: NexusChatPreferences
  hasMemoryCapability: boolean
  memoryData: NexusMemoryTabData
}

export function SettingsClient({
  profileData,
  apiKeys,
  nexusPreferences,
  hasMemoryCapability,
  memoryData,
}: SettingsClientProps) {
  return (
    <Tabs defaultValue="profile" className="w-full">
      <TabsList
        className={`grid w-full ${
          hasMemoryCapability ? "grid-cols-4" : "grid-cols-3"
        }`}
      >
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="api-keys">API Keys</TabsTrigger>
        <TabsTrigger value="preferences">Preferences</TabsTrigger>
        {hasMemoryCapability && (
          <TabsTrigger value="memory">Memory</TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="profile" className="mt-6">
        <ProfileTab data={profileData} />
      </TabsContent>

      <TabsContent value="api-keys" className="mt-6">
        <ApiKeysTab
          initialKeys={apiKeys}
          userRoles={profileData?.roles ?? []}
        />
      </TabsContent>

      <TabsContent value="preferences" className="mt-6">
        <PreferencesTab initialPreferences={nexusPreferences} />
      </TabsContent>

      {hasMemoryCapability && (
        <TabsContent value="memory" className="mt-6">
          <MemoryTab initialData={memoryData} />
        </TabsContent>
      )}
    </Tabs>
  )
}
