"use client"

import { Settings2 } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function PreferencesTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preferences</CardTitle>
        <CardDescription>
          Customize your AI Studio experience.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Settings2 className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="font-semibold">Coming Soon</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Preference settings like theme, notification preferences, and
            default AI model selection will be available here in a future update.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
