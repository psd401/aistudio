"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ModelSelector } from "@/components/features/model-selector"
import { IconPlayerPlay, IconPlayerStop, IconRefresh, IconSend } from "@tabler/icons-react"
import type { SelectAiModel } from "@/types"
import { useModels } from "@/lib/hooks/use-models"
import { useRef, useEffect } from "react"

interface CompareInputProps {
  prompt: string
  onPromptChange: (value: string) => void
  selectedModel1: SelectAiModel | null
  selectedModel2: SelectAiModel | null
  onModel1Change: (model: SelectAiModel) => void
  onModel2Change: (model: SelectAiModel) => void
  onSubmit: () => void
  isLoading: boolean
  onNewComparison: () => void
  hasResponses: boolean
}

export function CompareInput({
  prompt,
  onPromptChange,
  selectedModel1,
  selectedModel2,
  onModel1Change,
  onModel2Change,
  onSubmit,
  isLoading,
  onNewComparison,
  hasResponses
}: CompareInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { models } = useModels()

  // Auto-resize textarea based on content
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
      const scrollHeight = textareaRef.current.scrollHeight
      const maxHeight = 200
      const minHeight = 48
      const finalHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight)
      textareaRef.current.style.height = `${finalHeight}px`
    }
  }, [prompt])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !isLoading) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="border-b border-gray-200 p-6 space-y-4">
      {/* Model Selectors */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="block text-sm font-medium text-gray-700 mb-2" aria-hidden="true">
            Model 1
          </div>
          <ModelSelector
            models={models}
            value={selectedModel1}
            onChange={onModel1Change}
            requiredCapabilities={["chat"]}
            placeholder="Select first model"
            showDescription={false}
            groupByProvider={true}
            hideRoleRestricted={true}
            hideCapabilityMissing={true}
            aria-label="Select first model"
          />
        </div>
        <div>
          <div className="block text-sm font-medium text-gray-700 mb-2" aria-hidden="true">
            Model 2
          </div>
          <ModelSelector
            models={models}
            value={selectedModel2}
            onChange={onModel2Change}
            requiredCapabilities={["chat"]}
            placeholder="Select second model"
            showDescription={false}
            groupByProvider={true}
            hideRoleRestricted={true}
            hideCapabilityMissing={true}
            aria-label="Select second model"
          />
        </div>
      </div>

      {/* Input and Actions */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="flex-1 relative">
          <Textarea
            ref={textareaRef}
            id="compare-prompt-input"
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter a prompt to compare model responses..."
            disabled={!selectedModel1 || !selectedModel2 || isLoading}
            className="min-h-[48px] w-full resize-none bg-background py-3 pr-14 pl-4 border border-border rounded-xl shadow-sm focus-visible:ring-1 focus-visible:ring-primary"
            style={{ maxHeight: "200px", overflowY: "auto" }}
            aria-label="Comparison prompt"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!selectedModel1 || !selectedModel2 || !prompt.trim() || isLoading}
            className="absolute right-2 top-1/2 -translate-y-1/2 h-10 w-10"
            aria-label="Submit comparison"
          >
            <IconSend className="h-4 w-4" />
          </Button>
        </div>
        
        {/* Action Buttons */}
        <div className="flex gap-2">
          {!isLoading ? (
            hasResponses ? (
              <Button
                onClick={onNewComparison}
                variant="outline"
                size="icon"
                className="h-[48px] w-[48px]"
                aria-label="New comparison"
              >
                <IconRefresh className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={onSubmit}
                disabled={!selectedModel1 || !selectedModel2 || !prompt.trim()}
                size="icon"
                className="h-[48px] w-[48px]"
                aria-label="Start comparison"
              >
                <IconPlayerPlay className="h-4 w-4" />
              </Button>
            )
          ) : (
            <Button
              variant="destructive"
              size="icon"
              className="h-[48px] w-[48px]"
              disabled
              aria-label="Processing"
            >
              <IconPlayerStop className="h-4 w-4" />
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}