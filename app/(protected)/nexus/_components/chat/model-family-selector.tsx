"use client"

import { useState } from "react"
import { Bot, Check, ChevronDown, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { NexusExperienceMode, NexusModelFamily } from "@/lib/nexus/model-router/types"

const FAMILY_OPTIONS: Array<{ value: NexusModelFamily; label: string; description: string }> = [
  { value: "auto", label: "Auto", description: "Let Nexus choose the best model family" },
  { value: "openai", label: "ChatGPT", description: "Route within the OpenAI family" },
  { value: "anthropic", label: "Claude", description: "Route within the Claude family" },
  { value: "google", label: "Gemini", description: "Route within the Gemini family" },
]

export function ModelFamilySelector({
  mode,
  family,
  onModeChange,
  onFamilyChange,
}: {
  mode: NexusExperienceMode
  family: NexusModelFamily
  onModeChange: (mode: NexusExperienceMode) => void
  onFamilyChange: (family: NexusModelFamily) => void
}) {
  const [open, setOpen] = useState(false)
  const selectedLabel = FAMILY_OPTIONS.find(option => option.value === family)?.label ?? "Auto"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" aria-label="Nexus routing mode">
          {mode === "standard" ? <SlidersHorizontal className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
          <span>{mode === "standard" ? "Standard" : selectedLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="mb-2 px-2 py-1">
          <p className="text-sm font-medium">Nexus routing</p>
          <p className="text-xs text-muted-foreground">Standard chooses automatically. Advanced lets you constrain the model family.</p>
        </div>
        <button
          type="button"
          data-testid="nexus-mode-standard"
          className={cn("w-full rounded-md px-2 py-2 text-left hover:bg-muted", mode === "standard" && "bg-muted")}
          onClick={() => { onModeChange("standard"); setOpen(false) }}
        >
          <span className="flex items-center justify-between text-sm font-medium">Standard {mode === "standard" && <Check className="h-4 w-4" />}</span>
          <span className="text-xs text-muted-foreground">No model or tool decisions needed</span>
        </button>
        <div className="my-2 border-t" />
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Advanced family</p>
        {FAMILY_OPTIONS.map(option => (
          <button
            type="button"
            key={option.value}
            data-testid={`nexus-family-${option.value}`}
            className={cn("w-full rounded-md px-2 py-2 text-left hover:bg-muted", mode === "advanced" && family === option.value && "bg-muted")}
            onClick={() => { onFamilyChange(option.value); setOpen(false) }}
          >
            <span className="flex items-center justify-between text-sm font-medium">
              {option.label}
              {mode === "advanced" && family === option.value && <Check className="h-4 w-4" />}
            </span>
            <span className="text-xs text-muted-foreground">{option.description}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
