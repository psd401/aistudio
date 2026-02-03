"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProfileTab } from "./profile-tab"
import { ApiKeysTab } from "./api-keys-tab"
import { PreferencesTab } from "./preferences-tab"
import type { UserProfileData } from "@/actions/settings/user-settings.actions"
import type { ApiKeyInfo } from "@/lib/api-keys/key-service"

interface SettingsClientProps {
  profileData: UserProfileData | null
  apiKeys: ApiKeyInfo[]
}

export function SettingsClient({ profileData, apiKeys }: SettingsClientProps) {
  return (
    <Tabs defaultValue="profile" className="w-full">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="api-keys">API Keys</TabsTrigger>
        <TabsTrigger value="preferences">Preferences</TabsTrigger>
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
        <PreferencesTab />
      </TabsContent>
    </Tabs>
  )
}
