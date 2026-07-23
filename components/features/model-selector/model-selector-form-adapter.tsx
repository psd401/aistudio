"use client"

import { useCallback, useMemo } from "react"
import { ModelSelector } from "./model-selector"
import type { SelectAiModel } from "@/types"

interface ModelSelectorFormAdapterProps {
  models: SelectAiModel[]
  value: string | null | undefined
  onValueChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  showDescription?: boolean
  requiredCapabilities?: string[]
  hideCapabilityMissing?: boolean
}

/**
 * Adapter component that makes ModelSelector compatible with form libraries
 * that expect string values (like the Select component it's replacing)
 */
export function ModelSelectorFormAdapter({
  models,
  value,
  onValueChange,
  placeholder = "Select an AI model",
  disabled = false,
  className,
  showDescription = true,
  requiredCapabilities = [],
  hideCapabilityMissing = false
}: ModelSelectorFormAdapterProps) {
  // Convert string ID to model object
  const selectedModel = useMemo(() => {
    if (!value) return null
    return models.find(m => m.id.toString() === value) || null
  }, [value, models])

  // Convert model selection to string ID
  const handleChange = useCallback((model: SelectAiModel) => {
    onValueChange(model.id.toString())
  }, [onValueChange])

  return (
    <ModelSelector
      models={models}
      value={selectedModel}
      onChange={handleChange}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      showDescription={showDescription}
      groupByProvider={true}
      requiredCapabilities={requiredCapabilities}
      hideCapabilityMissing={hideCapabilityMissing}
    />
  )
}