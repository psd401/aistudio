"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { CompareInput } from "./compare-input"
import { DualResponse } from "./dual-response"
import { useToast } from "@/components/ui/use-toast"
import { useModelsWithPersistence } from "@/lib/hooks/use-models"
import { PageBranding } from "@/components/ui/page-branding"

// Note: This component now uses native streaming instead of polling
// The backend streams both model responses in parallel via Server-Sent Events

interface DualStreamEvent {
  modelId: 'model1' | 'model2';
  type: 'content' | 'finish' | 'error';
  chunk?: string;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

export function ModelCompare() {
  // Use shared model management hooks
  const model1State = useModelsWithPersistence('compareModel1', ['chat'])
  const model2State = useModelsWithPersistence('compareModel2', ['chat'])

  const [prompt, setPrompt] = useState("")
  const [model1Response, setModel1Response] = useState("")
  const [model2Response, setModel2Response] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [model1Complete, setModel1Complete] = useState(false)
  const [model2Complete, setModel2Complete] = useState(false)
  const { toast } = useToast()

  // Track active stream reader for cleanup
  const streamReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)

  const handleSubmit = useCallback(async () => {
    if (!model1State.selectedModel || !model2State.selectedModel) {
      toast({
        title: "Select both models",
        description: "Please select two models to compare",
        variant: "destructive"
      })
      return
    }

    if (!prompt.trim()) {
      toast({
        title: "Enter a prompt",
        description: "Please enter a prompt to send to the models",
        variant: "destructive"
      })
      return
    }

    if (model1State.selectedModel.id === model2State.selectedModel.id) {
      toast({
        title: "Select different models",
        description: "Please select two different models to compare",
        variant: "destructive"
      })
      return
    }

    // Clear previous responses and start processing
    setModel1Response("")
    setModel2Response("")
    setModel1Complete(false)
    setModel2Complete(false)
    setIsLoading(true)
    setIsStreaming(true)

    try {
      // Close any existing stream
      if (streamReaderRef.current) {
        try {
          await streamReaderRef.current.cancel()
        } catch {
          // Ignore cancel errors
        }
        streamReaderRef.current = null
      }

      // Create comparison request using fetch to get the stream
      const response = await fetch('/api/compare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: prompt.trim(),
          model1Id: model1State.selectedModel.modelId,
          model2Id: model2State.selectedModel.modelId,
          model1Name: model1State.selectedModel.name,
          model2Name: model2State.selectedModel.name,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || 'Failed to start comparison')
      }

      // Check if response is SSE stream
      const contentType = response.headers.get('Content-Type')
      if (!contentType?.includes('text/event-stream')) {
        throw new Error('Expected SSE stream but received different content type')
      }

      // Read the stream
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      if (!reader) {
        throw new Error('Failed to get stream reader')
      }

      // Store reader for cleanup
      streamReaderRef.current = reader

      setIsLoading(false)

      try {
        // Process the stream
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            break
          }

          // Decode the chunk and add to buffer
          buffer += decoder.decode(value, { stream: true })

          // Process complete SSE messages
          const lines = buffer.split('\n')
          buffer = lines.pop() || '' // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6)) as DualStreamEvent

                // Handle events based on model ID
                if (data.modelId === 'model1') {
                  if (data.type === 'content' && data.chunk) {
                    setModel1Response(prev => prev + data.chunk)
                  } else if (data.type === 'finish') {
                    setModel1Complete(true)
                  } else if (data.type === 'error') {
                    setModel1Complete(true)
                    toast({
                      title: "Model 1 Error",
                      description: data.error || "Model 1 failed to generate response",
                      variant: "destructive"
                    })
                  }
                } else if (data.modelId === 'model2') {
                  if (data.type === 'content' && data.chunk) {
                    setModel2Response(prev => prev + data.chunk)
                  } else if (data.type === 'finish') {
                    setModel2Complete(true)
                  } else if (data.type === 'error') {
                    setModel2Complete(true)
                    toast({
                      title: "Model 2 Error",
                      description: data.error || "Model 2 failed to generate response",
                      variant: "destructive"
                    })
                  }
                }
              } catch (parseError) {
                // Log parse errors in development for debugging
                if (process.env.NODE_ENV === 'development') {
                  // eslint-disable-next-line no-console
                  console.warn('Failed to parse SSE event:', line, parseError)
                }
                // In production, silently ignore - server-side logging handles errors
              }
            }
          }
        }

        // Stream complete
        setIsStreaming(false)
      } finally {
        // Always cleanup the reader
        if (streamReaderRef.current) {
          try {
            await streamReaderRef.current.cancel()
          } catch {
            // Ignore cancel errors
          }
          streamReaderRef.current = null
        }
      }

    } catch (error) {
      toast({
        title: "Comparison Failed",
        description: error instanceof Error ? error.message : "Failed to compare models",
        variant: "destructive"
      })
      setIsStreaming(false)
      setIsLoading(false)
    }
  }, [model1State.selectedModel, model2State.selectedModel, prompt, toast])

  const handleNewComparison = useCallback(() => {
    // Close any active stream
    if (streamReaderRef.current) {
      streamReaderRef.current.cancel().catch(() => {
        // Ignore cancel errors
      })
      streamReaderRef.current = null
    }

    setModel1Response("")
    setModel2Response("")
    setPrompt("")
    setIsStreaming(false)
    setIsLoading(false)
    setModel1Complete(false)
    setModel2Complete(false)
  }, [])

  const handleStopStreaming = useCallback(() => {
    // Close the stream
    if (streamReaderRef.current) {
      streamReaderRef.current.cancel().catch(() => {
        // Ignore cancel errors
      })
      streamReaderRef.current = null
    }

    setIsStreaming(false)
    setIsLoading(false)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamReaderRef.current) {
        streamReaderRef.current.cancel().catch(() => {
          // Ignore cancel errors
        })
      }
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      {/* Page Title */}
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">Model Comparison</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Compare how different AI models respond to the same prompt
        </p>
      </div>

      {/* Main Content Container */}
      <div className="flex-1 bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col">
        <CompareInput
          prompt={prompt}
          onPromptChange={setPrompt}
          selectedModel1={model1State.selectedModel}
          selectedModel2={model2State.selectedModel}
          onModel1Change={model1State.setSelectedModel}
          onModel2Change={model2State.setSelectedModel}
          onSubmit={handleSubmit}
          isLoading={isLoading}
          onNewComparison={handleNewComparison}
          hasResponses={model1Response.length > 0 || model2Response.length > 0}
        />

        <div className="flex-1 overflow-hidden">
          <DualResponse
            model1={{
              model: model1State.selectedModel,
              response: model1Response,
              status: isStreaming && !model1Complete ? 'streaming' : 'ready',
              error: undefined
            }}
            model2={{
              model: model2State.selectedModel,
              response: model2Response,
              status: isStreaming && !model2Complete ? 'streaming' : 'ready',
              error: undefined
            }}
            onStopModel1={handleStopStreaming}
            onStopModel2={handleStopStreaming}
          />
        </div>
      </div>
    </div>
  )
}
