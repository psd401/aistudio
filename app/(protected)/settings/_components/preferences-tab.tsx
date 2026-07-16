"use client"

import { useState } from "react"
import { Check, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { updateNexusChatPreferences, type NexusChatPreferences } from "@/actions/settings/user-settings.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

const FAMILIES: Array<{ value: NexusChatPreferences["family"]; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "openai", label: "ChatGPT" },
  { value: "anthropic", label: "Claude" },
  { value: "google", label: "Gemini" },
]

export function PreferencesTab({ initialPreferences }: { initialPreferences: NexusChatPreferences }) {
  const [preferences, setPreferences] = useState(initialPreferences)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const result = await updateNexusChatPreferences(preferences)
      if (!result.isSuccess) throw new Error(result.message)
      toast.success("Nexus preferences saved")
    } catch {
      toast.error("Could not save Nexus preferences")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5" />Nexus chat</CardTitle>
        <CardDescription>Let Nexus choose automatically, or constrain routing to a model family.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          {(["standard", "advanced"] as const).map(mode => (
            <button
              key={mode}
              type="button"
              data-testid={`nexus-preference-${mode}`}
              className={cn("rounded-lg border p-4 text-left", preferences.mode === mode && "border-primary bg-primary/5")}
              onClick={() => setPreferences(current => ({ ...current, mode }))}
            >
              <span className="flex items-center justify-between font-medium capitalize">
                {mode}{preferences.mode === mode && <Check className="h-4 w-4" />}
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {mode === "standard" ? "Nexus chooses the model and tools for you." : "Choose a family; Nexus still chooses the right power level."}
              </span>
            </button>
          ))}
        </div>

        {preferences.mode === "advanced" && (
          <div>
            <p className="mb-2 text-sm font-medium">Preferred model family</p>
            <div className="flex flex-wrap gap-2">
              {FAMILIES.map(option => (
                <Button
                  type="button"
                  key={option.value}
                  data-testid={`nexus-preference-family-${option.value}`}
                  variant={preferences.family === option.value ? "default" : "outline"}
                  onClick={() => setPreferences(current => ({ ...current, family: option.value }))}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        <Button data-testid="nexus-preference-save" type="button" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save preferences"}</Button>
      </CardContent>
    </Card>
  )
}
