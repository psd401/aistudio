"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Activity, Save } from "lucide-react"
import { updateNexusRouterSettings } from "@/actions/settings/nexus-router-settings.actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { useToast } from "@/components/ui/use-toast"
import {
  nexusRouterConfigSchema,
  nexusRouterRuntimeModeSchema,
  type NexusModelFamily,
  type NexusRouterConfig,
  type NexusRouterRuntimeMode,
  type NexusRouterTier,
} from "@/lib/nexus/model-router/types"
import type { Setting } from "@/actions/db/settings-actions"

const AUTOMATIC = "__automatic__"
const TIER_OPTIONS: Array<{ value: NexusRouterTier; label: string }> = [
  { value: "light", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
]
const FAMILY_ROWS: Array<{
  value: NexusModelFamily
  label: string
  description: string
}> = [
  { value: "auto", label: "Standard", description: "All eligible providers" },
  { value: "openai", label: "ChatGPT", description: "OpenAI family" },
  { value: "anthropic", label: "Claude", description: "Anthropic family" },
  { value: "google", label: "Gemini", description: "Google family" },
]

export interface NexusRouterModelOption {
  id: number
  name: string
  provider: string
  modelId: string
  family: Exclude<NexusModelFamily, "auto"> | null
  imageGeneration: boolean
  deepResearch: boolean
}

export interface NexusRouterConnectorOption {
  id: string
  name: string
}

function parseInitialSettings(settings: Setting[]): {
  mode: NexusRouterRuntimeMode
  architectMode: NexusRouterRuntimeMode
  config: NexusRouterConfig
} {
  const modeValue = settings.find(setting => setting.key === "NEXUS_ROUTER_MODE")?.value
  const modeResult = nexusRouterRuntimeModeSchema.safeParse(modeValue ?? "active")
  const architectModeValue = settings.find(setting => setting.key === "ASSISTANT_ARCHITECT_ROUTER_MODE")?.value
  const architectModeResult = nexusRouterRuntimeModeSchema.safeParse(architectModeValue ?? "active")
  const architectMode = architectModeResult.success ? architectModeResult.data : "shadow"
  const rawConfig = settings.find(setting => setting.key === "NEXUS_ROUTER_CONFIG_V1")?.value
  if (!rawConfig) return { mode: modeResult.success ? modeResult.data : "shadow", architectMode, config: nexusRouterConfigSchema.parse({}) }

  try {
    const configResult = nexusRouterConfigSchema.safeParse(JSON.parse(rawConfig) as unknown)
    if (configResult.success) {
      return { mode: modeResult.success ? modeResult.data : "shadow", architectMode, config: configResult.data }
    }
  } catch {
    // The card deliberately falls back to a valid, editable configuration.
  }
  return { mode: "shadow", architectMode: "shadow", config: nexusRouterConfigSchema.parse({}) }
}

function getTierCandidates(
  config: NexusRouterConfig,
  family: NexusModelFamily,
  tier: NexusRouterTier
): string[] {
  return family === "auto" ? config.auto[tier] : config.families[family][tier]
}

function replaceTierCandidate(
  config: NexusRouterConfig,
  family: NexusModelFamily,
  tier: NexusRouterTier,
  modelId: string
): NexusRouterConfig {
  const candidates = modelId === AUTOMATIC ? [] : [modelId]
  if (family === "auto") {
    return { ...config, auto: { ...config.auto, [tier]: candidates } }
  }
  return {
    ...config,
    families: {
      ...config.families,
      [family]: { ...config.families[family], [tier]: candidates },
    },
  }
}

function RouterModelSelect({
  value,
  models,
  automaticLabel,
  testId,
  onChange,
}: {
  value?: string
  models: NexusRouterModelOption[]
  automaticLabel: string
  testId: string
  onChange: (value: string) => void
}) {
  return (
    <Select value={value ?? AUTOMATIC} onValueChange={onChange}>
      <SelectTrigger data-testid={testId} className="min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTOMATIC}>{automaticLabel}</SelectItem>
        {models.map(model => (
          <SelectItem key={model.id} value={model.modelId}>
            {model.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function NexusRouterSettingsCard({
  settings,
  models,
  connectors,
}: {
  settings: Setting[]
  models: NexusRouterModelOption[]
  connectors: NexusRouterConnectorOption[]
}) {
  const initial = useMemo(() => parseInitialSettings(settings), [settings])
  const [mode, setMode] = useState<NexusRouterRuntimeMode>(initial.mode)
  const [architectMode, setArchitectMode] = useState<NexusRouterRuntimeMode>(initial.architectMode)
  const [config, setConfig] = useState<NexusRouterConfig>(initial.config)
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()
  const router = useRouter()

  const textModels = useMemo(
    () => models.filter(model => !model.imageGeneration && !model.deepResearch),
    [models]
  )
  const imageModels = useMemo(() => models.filter(model => model.imageGeneration), [models])
  const googleTextModels = useMemo(
    () => textModels.filter(model => model.family === "google"),
    [textModels]
  )

  const save = async () => {
    setSaving(true)
    try {
      const result = await updateNexusRouterSettings({ mode, architectMode, config })
      if (!result.isSuccess) throw new Error(result.message)
      toast({ title: "Model routing saved", description: "New requests will use this configuration." })
      router.refresh()
    } catch (error) {
      toast({
        title: "Could not save model routing",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card data-testid="nexus-router-settings-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Model routing
            </CardTitle>
            <CardDescription className="mt-1">
              Share model tiers across Nexus and Assistant Architect while controlling each rollout independently.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={mode === "active" ? "default" : "secondary"}>Nexus · {mode}</Badge>
            <Badge variant={architectMode === "active" ? "default" : "secondary"}>
              Architect · {architectMode}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="nexus-router-mode">Nexus routing mode</Label>
            <Select value={mode} onValueChange={value => setMode(nexusRouterRuntimeModeSchema.parse(value))}>
              <SelectTrigger id="nexus-router-mode" data-testid="nexus-router-admin-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active — route live requests</SelectItem>
                <SelectItem value="shadow">Observe only — record proposals, use fallback</SelectItem>
                <SelectItem value="off">Off — always use fallback</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Observe-only mode is why every executed request appears as the fallback model in activity reports.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="assistant-architect-router-mode">Assistant Architect routing mode</Label>
            <Select value={architectMode} onValueChange={value => setArchitectMode(nexusRouterRuntimeModeSchema.parse(value))}>
              <SelectTrigger id="assistant-architect-router-mode" data-testid="assistant-architect-router-admin-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active — route live executions</SelectItem>
                <SelectItem value="shadow">Observe only — record proposals, use fallback</SelectItem>
                <SelectItem value="off">Off — always use fallback</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Applies to Standard and Advanced assistants; legacy assistants stay pinned.
            </p>
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <div>
            <h3 className="font-medium">Model tiers</h3>
            <p className="text-sm text-muted-foreground">
              Choose a preferred model or leave a slot automatic to use capability and tier inference.
            </p>
          </div>
          <div className="overflow-x-auto">
            <div className="grid min-w-[760px] grid-cols-[150px_repeat(3,minmax(180px,1fr))] gap-3">
              <div />
              {TIER_OPTIONS.map(tier => <Label key={tier.value}>{tier.label}</Label>)}
              {FAMILY_ROWS.flatMap(row => {
                const eligibleModels = row.value === "auto"
                  ? textModels
                  : textModels.filter(model => model.family === row.value)
                return [
                  <div key={`${row.value}-label`} className="py-2">
                    <div className="text-sm font-medium">{row.label}</div>
                    <div className="text-xs text-muted-foreground">{row.description}</div>
                  </div>,
                  ...TIER_OPTIONS.map(tier => (
                    <RouterModelSelect
                      key={`${row.value}-${tier.value}`}
                      value={getTierCandidates(config, row.value, tier.value)[0]}
                      models={eligibleModels}
                      automaticLabel="Automatic"
                      testId={`nexus-router-${row.value}-${tier.value}`}
                      onChange={modelId => setConfig(current => replaceTierCandidate(current, row.value, tier.value, modelId))}
                    />
                  )),
                ]
              })}
            </div>
          </div>
        </div>

        <Separator />

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-2">
            <Label>Instructional questions</Label>
            <RouterModelSelect
              value={config.specialists.instructionModels[0]}
              models={googleTextModels}
              automaticLabel="Automatic Gemini"
              testId="nexus-router-instruction-model"
              onChange={modelId => setConfig(current => ({
                ...current,
                specialists: {
                  ...current.specialists,
                  instructionModels: modelId === AUTOMATIC ? [] : [modelId],
                },
              }))}
            />
            <p className="text-xs text-muted-foreground">Lesson plans, rubrics, curriculum, and pedagogy.</p>
          </div>
          <div className="space-y-2">
            <Label>Image generation</Label>
            <RouterModelSelect
              value={config.specialists.imageModels[0]}
              models={imageModels}
              automaticLabel="Automatic image model"
              testId="nexus-router-image-model"
              onChange={modelId => setConfig(current => ({
                ...current,
                specialists: {
                  ...current.specialists,
                  imageModels: modelId === AUTOMATIC ? [] : [modelId],
                },
              }))}
            />
            <p className="text-xs text-muted-foreground">Used automatically for image creation and edits.</p>
          </div>
          <div className="space-y-2">
            <Label>PSD-data connection</Label>
            <Select
              value={config.specialists.psdDataConnectorId ?? AUTOMATIC}
              onValueChange={connectorId => setConfig(current => ({
                ...current,
                specialists: {
                  ...current.specialists,
                  psdDataConnectorId: connectorId === AUTOMATIC ? undefined : connectorId,
                },
              }))}
            >
              <SelectTrigger data-testid="nexus-router-psd-connector"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTOMATIC}>Match “{config.specialists.psdDataConnectorName}” by name</SelectItem>
                {connectors.map(connector => (
                  <SelectItem key={connector.id} value={connector.id}>{connector.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Automatically attached only for authorized district-data requests.</p>
          </div>
        </div>

        <Separator />

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="nexus-classifier-provider">Classifier provider</Label>
            <Input
              id="nexus-classifier-provider"
              value={config.classifier.provider}
              onChange={event => setConfig(current => ({
                ...current,
                classifier: { ...current.classifier, provider: event.target.value },
              }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nexus-classifier-model">Classifier model</Label>
            <Input
              id="nexus-classifier-model"
              data-testid="nexus-router-classifier-model"
              value={config.classifier.modelId}
              onChange={event => setConfig(current => ({
                ...current,
                classifier: { ...current.classifier, modelId: event.target.value },
              }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nexus-confidence-floor">Confidence floor</Label>
            <Input
              id="nexus-confidence-floor"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={config.confidenceFloor}
              onChange={event => setConfig(current => ({
                ...current,
                confidenceFloor: Number(event.target.value),
              }))}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button data-testid="nexus-router-admin-save" onClick={save} disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving…" : "Save Nexus routing"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
