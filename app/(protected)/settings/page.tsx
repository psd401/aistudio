import { redirect } from "next/navigation"
import { getServerSession } from "@/lib/auth/server-session"
import { getUserProfile, listUserApiKeys } from "@/actions/settings/user-settings.actions"
import { SettingsClient } from "./_components/settings-client"

export const metadata = {
  title: "Settings | AI Studio",
}

export default async function SettingsPage() {
  const session = await getServerSession()
  if (!session) {
    redirect("/")
  }

  const [profileResult, keysResult] = await Promise.all([
    getUserProfile(),
    listUserApiKeys(),
  ])

  return (
    <div className="container mx-auto max-w-4xl py-8 px-4">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your profile, API keys, and preferences
        </p>
      </div>

      <SettingsClient
        profileData={profileResult.isSuccess ? profileResult.data : null}
        apiKeys={keysResult.isSuccess ? keysResult.data : []}
      />
    </div>
  )
}
