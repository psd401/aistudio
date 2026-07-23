"use client"

import { Bot, Check, ChevronDown, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { NexusExperienceMode, NexusModelFamily } from "@/lib/nexus/model-router/types"

type AdvancedFamily = Exclude<NexusModelFamily, "auto">

const ADVANCED_FAMILIES: Array<{ value: AdvancedFamily; label: string }> = [
  { value: "openai", label: "ChatGPT" },
  { value: "anthropic", label: "Claude" },
  { value: "google", label: "Gemini" },
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
  const selectedFamily = ADVANCED_FAMILIES.find(option => option.value === family)
  const triggerLabel = mode === "standard"
    ? "Standard"
    : selectedFamily
      ? `Advanced · ${selectedFamily.label}`
      : "Advanced"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" aria-label="Nexus routing mode">
          {mode === "standard" ? <SlidersHorizontal className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
          <span>{triggerLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-52" align="start">
        <DropdownMenuItem
          data-testid="nexus-mode-standard"
          onSelect={() => onModeChange("standard")}
        >
          <span>Standard</span>
          {mode === "standard" && <Check className="ml-auto h-4 w-4" />}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="nexus-mode-advanced">
            <span>Advanced</span>
            {mode === "advanced" && <Check className="ml-auto mr-2 h-4 w-4" />}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            {ADVANCED_FAMILIES.map(option => (
              <DropdownMenuItem
                key={option.value}
                data-testid={`nexus-family-${option.value}`}
                onSelect={() => onFamilyChange(option.value)}
              >
                <span>{option.label}</span>
                {mode === "advanced" && family === option.value && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
