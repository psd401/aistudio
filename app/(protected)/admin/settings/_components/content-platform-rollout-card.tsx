"use client"

import { useState } from "react"
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import type {
  CreateSettingInput,
  Setting,
} from "@/actions/db/settings-actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"

export const CONTENT_ROLLOUT_SETTING_KEYS = [
  "CONTENT_PLATFORM_ENABLED",
  "CONTENT_DUAL_WRITE_ENABLED",
  "CONTENT_READ_V2_ENABLED",
  "CONTENT_RETRIEVAL_SHADOW_ENABLED",
  "CONTENT_REPOSITORY_CUTOVER_ENABLED",
  "CONTENT_NEXUS_CUTOVER_ENABLED",
  "CONTENT_ASSISTANT_ARCHITECT_CUTOVER_ENABLED",
  "CONTENT_LEGACY_RETIREMENT_ENABLED",
] as const

const STAGES = [
  ["CONTENT_PLATFORM_ENABLED", "Platform foundation"],
  ["CONTENT_DUAL_WRITE_ENABLED", "Dual write"],
  ["CONTENT_READ_V2_ENABLED", "Canonical reads"],
  ["CONTENT_RETRIEVAL_SHADOW_ENABLED", "Retrieval shadow"],
  ["CONTENT_REPOSITORY_CUTOVER_ENABLED", "Repository Manager"],
  ["CONTENT_NEXUS_CUTOVER_ENABLED", "Nexus"],
  ["CONTENT_ASSISTANT_ARCHITECT_CUTOVER_ENABLED", "Assistant Architect"],
  ["CONTENT_LEGACY_RETIREMENT_ENABLED", "Legacy retirement"],
] as const

export interface ContentRolloutEvidence {
  blockers: string[]
  dryRunCompleted: boolean
  rollbackDrillCompleted: boolean
  uncoveredSources: number
  activeRunCount: number
  staleRepositoryCount: number
  shadowObservations: number
}

export function ContentPlatformRolloutCard({
  settings,
  evidence,
  onSave,
}: {
  settings: Setting[]
  evidence: ContentRolloutEvidence
  onSave: (input: CreateSettingInput) => Promise<void>
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const settingsByKey = new Map(settings.map(setting => [setting.key, setting]))

  async function updateStage(key: string, enabled: boolean) {
    const setting = settingsByKey.get(key)
    if (!setting) return
    setPendingKey(key)
    try {
      await onSave({
        key,
        value: String(enabled),
        description: setting.description,
        category: setting.category,
        isSecret: false,
      })
    } finally {
      setPendingKey(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          Guided repository rollout
          <Badge variant={evidence.blockers.length > 0 ? "destructive" : "secondary"}>
            {evidence.blockers.length > 0
              ? `${evidence.blockers.length} blockers`
              : "Ready"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {evidence.blockers.length > 0 ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Cutover is blocked</AlertTitle>
            <AlertDescription>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {evidence.blockers.map(blocker => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Migration evidence is clear</AlertTitle>
            <AlertDescription>
              Continue in order. The server rejects skipped stages and unsafe
              rollback combinations.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <span>Uncovered sources: {evidence.uncoveredSources}</span>
          <span>Active migration runs: {evidence.activeRunCount}</span>
          <span>Stale repositories: {evidence.staleRepositoryCount}</span>
          <span>Shadow observations: {evidence.shadowObservations}</span>
          <span>Dry run: {evidence.dryRunCompleted ? "complete" : "required"}</span>
          <span>
            Rollback drill: {evidence.rollbackDrillCompleted ? "complete" : "required"}
          </span>
        </div>

        <div className="divide-y rounded-md border">
          {STAGES.map(([key, label], index) => {
            const setting = settingsByKey.get(key)
            if (!setting) return null
            const checked = setting.value === "true"
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div>
                  <p className="font-medium">
                    {index + 1}. {label}
                  </p>
                  <p className="text-xs text-muted-foreground">{key}</p>
                </div>
                <div className="flex items-center gap-2">
                  {pendingKey === key ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  <Switch
                    checked={checked}
                    disabled={pendingKey !== null}
                    onCheckedChange={enabled =>
                      void updateStage(key, enabled)
                    }
                    aria-label={`${checked ? "Disable" : "Enable"} ${label}`}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
