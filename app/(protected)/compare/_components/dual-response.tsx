"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ResponseDisplay } from "./response-display"
import { IconPlayerStop, IconCopy, IconCheck, IconLoader2 } from "@tabler/icons-react"
import type { SelectAiModel } from "@/types"

interface ModelResponse {
  model: SelectAiModel | null
  response: string
  status: 'ready' | 'streaming' | 'error'
  error?: string
}

interface DualResponseProps {
  model1: ModelResponse
  model2: ModelResponse
  onStopModel1: () => void
  onStopModel2: () => void
}

export function DualResponse({
  model1,
  model2,
  onStopModel1,
  onStopModel2
}: DualResponseProps) {
  const [copiedModel, setCopiedModel] = useState<'model1' | 'model2' | null>(null)

  const handleCopy = async (text: string, model: 'model1' | 'model2') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedModel(model)
      setTimeout(() => setCopiedModel(null), 2000)
    } catch {
      // Failed to copy - silently handle
    }
  }

  const renderResponse = (response: ModelResponse, modelKey: 'model1' | 'model2', onStop: () => void) => {
    const hasContent = response.response || response.error || response.status !== 'ready'

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 bg-gray-50">
          <h3 className="font-semibold text-sm text-gray-900">
            {response.model?.name || 'Select a model'}
          </h3>
          <div className="flex items-center gap-2">
            {response.status === 'streaming' && (
              <Button
                onClick={onStop}
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                data-testid="streaming-indicator"
              >
                <IconPlayerStop className="h-3 w-3" />
              </Button>
            )}
            {response.response && (
              <Button
                onClick={() => handleCopy(response.response, modelKey)}
                size="sm"
                variant="ghost"
                className="h-7 px-2"
              >
                {copiedModel === modelKey ? (
                  <IconCheck className="h-3 w-3 text-green-500" />
                ) : (
                  <IconCopy className="h-3 w-3" />
                )}
              </Button>
            )}
          </div>
        </div>
        
        <ScrollArea className="flex-1 p-4">
          {!hasContent && (
            <div className="text-center text-muted-foreground py-8">
              <p className="text-sm">Responses will appear here</p>
            </div>
          )}
          
          {response.error && (
            <div className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
              {response.error}
            </div>
          )}
          
          {response.status === 'streaming' && !response.response && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <IconLoader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">
                {response.model?.name || 'Model'} is thinking...
              </span>
            </div>
          )}

          {response.response && (
            <ResponseDisplay
              content={response.response}
            />
          )}
        </ScrollArea>
      </div>
    )
  }

  return (
    <>
      {/* Mobile view - Tabs */}
      <div className="md:hidden h-full">
        <Tabs defaultValue="model1" className="h-full flex flex-col">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="model1">
              {model1.model?.name || 'Model 1'}
            </TabsTrigger>
            <TabsTrigger value="model2">
              {model2.model?.name || 'Model 2'}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="model1" className="flex-1 mt-0">
            {renderResponse(model1, 'model1', onStopModel1)}
          </TabsContent>
          <TabsContent value="model2" className="flex-1 mt-0">
            {renderResponse(model2, 'model2', onStopModel2)}
          </TabsContent>
        </Tabs>
      </div>
      
      {/* Desktop view - Side by side */}
      <div className="hidden md:grid grid-cols-2 divide-x divide-gray-200 h-full">
        {renderResponse(model1, 'model1', onStopModel1)}
        {renderResponse(model2, 'model2', onStopModel2)}
      </div>
    </>
  )
}