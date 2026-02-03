'use client'

import { useState, useMemo, useCallback, memo } from 'react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Check, ChevronDown, Bot, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SelectAiModel } from '@/types'

interface ModelSelectorCompactProps {
  models: SelectAiModel[]
  selectedModel: SelectAiModel | null
  onModelChange: (model: SelectAiModel) => void
  isLoading?: boolean
}

// Provider display info
const PROVIDER_INFO: Record<string, { label: string; color: string }> = {
  openai: { label: 'OpenAI', color: 'text-emerald-600' },
  google: { label: 'Google', color: 'text-blue-600' },
  amazon: { label: 'Amazon', color: 'text-orange-600' },
  azure: { label: 'Azure', color: 'text-sky-600' },
}

// Extracted component to avoid inline function in map
interface ModelItemProps {
  model: SelectAiModel
  isSelected: boolean
  onSelect: (model: SelectAiModel) => void
}

const ModelItem = memo(function ModelItem({ model, isSelected, onSelect }: ModelItemProps) {
  const handleClick = useCallback(() => {
    onSelect(model)
  }, [model, onSelect])

  return (
    <button
      className={cn(
        'w-full flex items-center justify-between px-2 py-1.5 rounded-md text-left',
        'hover:bg-muted/50 transition-colors',
        isSelected && 'bg-muted'
      )}
      onClick={handleClick}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">{model.name || model.modelId}</p>
        {model.description && (
          <p className="text-xs text-muted-foreground truncate">{model.description}</p>
        )}
      </div>
      {isSelected && (
        <Check className="h-4 w-4 shrink-0 text-primary ml-2" />
      )}
    </button>
  )
})

export function ModelSelectorCompact({
  models,
  selectedModel,
  onModelChange,
  isLoading = false,
}: ModelSelectorCompactProps) {
  const [open, setOpen] = useState(false)

  // Group models by provider
  const groupedModels = useMemo(() => {
    const groups: Record<string, SelectAiModel[]> = {}
    for (const model of models) {
      const provider = model.provider || 'other'
      if (!groups[provider]) {
        groups[provider] = []
      }
      groups[provider].push(model)
    }
    return groups
  }, [models])

  const getDisplayName = (model: SelectAiModel | null) => {
    if (!model) return 'Select model'
    // Use name or fallback to modelId
    return model.name || model.modelId
  }

  const getProviderLabel = (provider: string) => {
    return PROVIDER_INFO[provider]?.label || provider.charAt(0).toUpperCase() + provider.slice(1)
  }

  const handleModelSelect = useCallback((model: SelectAiModel) => {
    onModelChange(model)
    setOpen(false)
  }, [onModelChange])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs max-w-[200px]"
          disabled={isLoading}
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Bot className="h-3.5 w-3.5" />
          )}
          <span className="truncate">{getDisplayName(selectedModel)}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="p-3 border-b">
          <h4 className="font-medium text-sm">AI Model</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            Choose the model for this conversation
          </p>
        </div>
        <div className="max-h-[300px] overflow-y-auto p-2">
          {Object.entries(groupedModels).map(([provider, providerModels]) => (
            <div key={provider} className="mb-2 last:mb-0">
              <p className={cn(
                'text-xs font-medium px-2 py-1',
                PROVIDER_INFO[provider]?.color || 'text-muted-foreground'
              )}>
                {getProviderLabel(provider)}
              </p>
              {providerModels.map((model) => (
                <ModelItem
                  key={model.modelId}
                  model={model}
                  isSelected={selectedModel?.modelId === model.modelId}
                  onSelect={handleModelSelect}
                />
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
