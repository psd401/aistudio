"use client"

import { useEffect, useRef, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select"
import {
  getAvailableAgentToolsAction,
  type AvailableAgentTool,
} from "@/actions/db/assistant-architect-actions"

export type AssistantMode = "prompt_chain" | "agentic"

/** Controlled agentic-mode config managed by this section (Issue #926). */
export interface AgenticConfigState {
  mode: AssistantMode
  enabledTools: string[]
  maxSteps: number
  timeoutSeconds: number
  /** Cost cap in whole US dollars (UI unit); converted to cents on save. */
  costCapDollars: number | null
  /** Per-assistant max runs per rolling hour; null = no cap (Issue #926). */
  maxRequestsPerHour: number | null
}

interface AgenticModeSectionProps {
  value: AgenticConfigState
  onChange: (next: AgenticConfigState) => void
  /**
   * When true the mode radio is locked to "agentic" with no opt-out — used when
   * editing an assistant already in agentic mode (the transition is one-way).
   */
  lockAgentic?: boolean
  disabled?: boolean
}

/**
 * Agentic-mode configuration for the Assistant Architect editor (Issue #926):
 * a mode selector (prompt-chain vs agentic), a tools picker (filtered by the
 * author's scopes), and the per-run step / timeout / cost limits. The tools
 * picker + limits render only when agentic mode is selected.
 */
export function AgenticModeSection({
  value,
  onChange,
  lockAgentic = false,
  disabled = false,
}: AgenticModeSectionProps) {
  const [availableTools, setAvailableTools] = useState<AvailableAgentTool[]>([])
  const [loadingTools, setLoadingTools] = useState(false)
  // Fetch the author-allowed agent tools at most once (the first time agentic
  // mode is selected). An ID-tracking ref prevents a re-fetch when the user
  // toggles mode back and forth.
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (value.mode !== "agentic" || fetchedRef.current) return
    let cancelled = false
    const load = async () => {
      setLoadingTools(true)
      try {
        const result = await getAvailableAgentToolsAction()
        if (!cancelled && result.isSuccess && result.data) {
          setAvailableTools(result.data)
          // Mark fetched only after a successful apply, so a cancelled/failed
          // first attempt (e.g. StrictMode unmount mid-fetch) can retry on
          // remount rather than leaving the picker permanently empty.
          fetchedRef.current = true
        }
      } finally {
        if (!cancelled) setLoadingTools(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [value.mode])

  const toolOptions: MultiSelectOption[] = availableTools.map((t) => ({
    value: t.identifier,
    label: t.name,
    description: t.description,
  }))

  const update = (patch: Partial<AgenticConfigState>) =>
    onChange({ ...value, ...patch })

  return (
    <Card data-testid="agentic-mode-section">
      <CardHeader>
        <CardTitle>Runtime mode</CardTitle>
        <CardDescription>
          Prompt-chain runs your prompts in order. Agentic lets the model call
          tools and decide what to do until the task is done.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <RadioGroup
          value={value.mode}
          onValueChange={(v) => update({ mode: v as AssistantMode })}
          disabled={disabled}
          data-testid="assistant-mode-selector"
        >
          <div className="flex items-start gap-3">
            <RadioGroupItem
              value="prompt_chain"
              id="mode-prompt-chain"
              disabled={disabled || lockAgentic}
            />
            <div className="grid gap-1">
              <Label htmlFor="mode-prompt-chain">Prompt chain</Label>
              <p className="text-sm text-muted-foreground">
                Ordered prompt-template execution with one model. Best for fixed,
                predictable workflows.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <RadioGroupItem
              value="agentic"
              id="mode-agentic"
              disabled={disabled}
            />
            <div className="grid gap-1">
              <Label htmlFor="mode-agentic">Agentic</Label>
              <p className="text-sm text-muted-foreground">
                A model loop with tool access. The model chooses which tools to
                call and continues until done. One-way: cannot revert to
                prompt-chain.
              </p>
            </div>
          </div>
        </RadioGroup>

        {value.mode === "agentic" && (
          <div className="space-y-6 border-t pt-6" data-testid="agentic-config">
            <div className="space-y-2">
              <Label htmlFor="agent-tools">Tools</Label>
              <p className="text-sm text-muted-foreground">
                {loadingTools
                  ? "Loading available tools…"
                  : "Tools the assistant may call. Only tools your role can use are shown."}
              </p>
              <MultiSelect
                options={toolOptions}
                value={value.enabledTools}
                onChange={(tools) => update({ enabledTools: tools })}
                placeholder="Select tools"
                disabled={disabled || loadingTools}
                className="w-full"
              />
            </div>

            <AgentLimitsGrid value={value} disabled={disabled} update={update} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** The step / timeout / cost-cap inputs for an agentic assistant. */
function AgentLimitsGrid({
  value,
  disabled,
  update,
}: {
  value: AgenticConfigState
  disabled: boolean
  update: (patch: Partial<AgenticConfigState>) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="space-y-2">
        <Label htmlFor="agent-max-steps">Max steps</Label>
        <Input
          id="agent-max-steps"
          type="number"
          min={1}
          max={50}
          value={value.maxSteps}
          disabled={disabled}
          onChange={(e) => update({ maxSteps: clampInt(e.target.value, 1, 50, 10) })}
          data-testid="agent-max-steps"
        />
        <p className="text-xs text-muted-foreground">1–50 tool round-trips.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="agent-timeout">Timeout (seconds)</Label>
        <Input
          id="agent-timeout"
          type="number"
          min={1}
          max={900}
          value={value.timeoutSeconds}
          disabled={disabled}
          onChange={(e) => update({ timeoutSeconds: clampInt(e.target.value, 1, 900, 300) })}
          data-testid="agent-timeout"
        />
        <p className="text-xs text-muted-foreground">1–900 seconds.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="agent-cost-cap">Cost cap (USD)</Label>
        <Input
          id="agent-cost-cap"
          type="number"
          min={0}
          step="0.01"
          value={value.costCapDollars ?? ""}
          disabled={disabled}
          placeholder="No cap"
          onChange={(e) => {
            const v = e.target.value.trim()
            update({ costCapDollars: v === "" ? null : Math.max(0, Number(v)) })
          }}
          data-testid="agent-cost-cap"
        />
        <p className="text-xs text-muted-foreground">Blank = no cap.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="agent-rate-limit">Runs per hour</Label>
        <Input
          id="agent-rate-limit"
          type="number"
          min={1}
          step="1"
          value={value.maxRequestsPerHour ?? ""}
          disabled={disabled}
          placeholder="No limit"
          onChange={(e) => {
            const v = e.target.value.trim()
            update({
              maxRequestsPerHour: v === "" ? null : Math.max(1, Math.floor(Number(v))),
            })
          }}
          data-testid="agent-rate-limit"
        />
        <p className="text-xs text-muted-foreground">Blank = no limit.</p>
      </div>
    </div>
  )
}

/** Parse + clamp an integer input, falling back to `fallback` on bad input. */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
