"use client"

import { Check, Route } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { AssistantModelFamily, AssistantModelRoutingMode } from "@/lib/db/schema/tables/assistant-architects"

export interface ModelRoutingState {
  mode: AssistantModelRoutingMode
  family: AssistantModelFamily | null
}

const FAMILY_LABELS: Record<AssistantModelFamily, string> = {
  openai: "ChatGPT",
  anthropic: "Claude",
  google: "Gemini",
}

export function ModelRoutingSection({
  value,
  onChange,
  disabled,
}: {
  value: ModelRoutingState
  onChange: (value: ModelRoutingState) => void
  disabled?: boolean
}) {
  const chooseMode = (mode: "standard" | "advanced") => {
    onChange({
      mode,
      family: mode === "advanced" ? value.family ?? "anthropic" : null,
    })
  }

  return (
    <Card data-testid="assistant-model-routing-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="h-5 w-5" />
          Model routing
        </CardTitle>
        <CardDescription>
          Let AI Studio choose the right model for each request, or constrain routing to one model family.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {value.mode === "legacy" && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="assistant-routing-legacy-notice">
            This existing assistant still uses its pinned prompt models. Choose Standard or Advanced to enable automatic routing.
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Button
            type="button"
            variant={value.mode === "standard" ? "default" : "outline"}
            className="h-auto justify-between px-4 py-4 text-left"
            onClick={() => chooseMode("standard")}
            disabled={disabled}
            data-testid="assistant-routing-standard"
            aria-pressed={value.mode === "standard"}
          >
            <span>
              <span className="block font-semibold">Standard</span>
              <span className="mt-1 block text-xs font-normal opacity-80">Automatically chooses across all eligible models.</span>
            </span>
            {value.mode === "standard" && <Check className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant={value.mode === "advanced" ? "default" : "outline"}
            className="h-auto justify-between px-4 py-4 text-left"
            onClick={() => chooseMode("advanced")}
            disabled={disabled}
            data-testid="assistant-routing-advanced"
            aria-pressed={value.mode === "advanced"}
          >
            <span>
              <span className="block font-semibold">Advanced</span>
              <span className="mt-1 block text-xs font-normal opacity-80">Routes within ChatGPT, Claude, or Gemini.</span>
            </span>
            {value.mode === "advanced" && <Check className="h-4 w-4" />}
          </Button>
        </div>
        {value.mode === "advanced" && (
          <div className="grid gap-2 sm:max-w-sm" data-testid="assistant-routing-family-flyout">
            <Label htmlFor="assistant-routing-family">Model family</Label>
            <Select
              value={value.family ?? "anthropic"}
              onValueChange={family => onChange({ mode: "advanced", family: family as AssistantModelFamily })}
              disabled={disabled}
            >
              <SelectTrigger id="assistant-routing-family" data-testid="assistant-routing-family">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(FAMILY_LABELS) as Array<[AssistantModelFamily, string]>).map(([family, label]) => (
                  <SelectItem key={family} value={family}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
