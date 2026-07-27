"use client";

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import { CompareInput } from "./compare-input";
import { DualResponse } from "./dual-response";
import { toast } from "sonner";
import { useModelsWithPersistence } from "@/lib/hooks/use-models";
import { PageBranding } from "@/components/ui/page-branding";
import { createLogger } from "@/lib/client-logger";
import type { DualStreamEvent } from "@/lib/compare/dual-stream-merger";
import { isSafeImageUrl } from "@/lib/utils/image-validation";

const log = createLogger({ module: "model-compare" });

/** Detect whether a model has the image_generation capability */
function isImageModel(
  model: { capabilities?: string | string[] | null } | null,
): boolean {
  if (!model?.capabilities) return false;
  try {
    const caps =
      typeof model.capabilities === "string"
        ? JSON.parse(model.capabilities)
        : model.capabilities;
    return Array.isArray(caps) && caps.includes("image_generation");
  } catch {
    return false;
  }
}

interface ModelEventActions {
  appendResponse: Dispatch<SetStateAction<string>>;
  setImageUrl: Dispatch<SetStateAction<string | undefined>>;
  setComplete: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | undefined>>;
}

function handleModelEvent(
  event: DualStreamEvent,
  modelLabel: string,
  actions: ModelEventActions,
): void {
  if (event.type === "content" && event.chunk) {
    actions.appendResponse((previous) => previous + event.chunk);
  } else if (event.type === "image" && event.imageUrl) {
    if (isSafeImageUrl(event.imageUrl)) {
      actions.setImageUrl(event.imageUrl);
    } else {
      log.warn(`Received unsafe imageUrl for ${event.modelId}, ignoring`);
      actions.setError("Image generation failed. Please try again.");
    }
  } else if (event.type === "finish") {
    actions.setComplete(true);
  } else if (event.type === "warning") {
    actions.setComplete(true);
    toast.warning(`${modelLabel} unavailable`, {
      description:
        event.warning ??
        "Comparison unavailable — model response could not be generated",
    });
  } else if (event.type === "error") {
    actions.setComplete(true);
    actions.setError(event.error);
  }
}

function processDualStreamLine(
  line: string,
  model1Label: string,
  model2Label: string,
  model1Actions: ModelEventActions,
  model2Actions: ModelEventActions,
): void {
  if (!line.startsWith("data: ")) return;

  try {
    const event = JSON.parse(line.slice(6)) as DualStreamEvent;
    if (event.modelId === "model1") {
      handleModelEvent(event, model1Label, model1Actions);
    } else if (event.modelId === "model2") {
      handleModelEvent(event, model2Label, model2Actions);
    }
  } catch (error) {
    log.warn("Failed to parse SSE event", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function consumeDualStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) onLine(line);
  }
}

type ComparisonModel = NonNullable<
  ReturnType<typeof useModelsWithPersistence>["selectedModel"]
>;

interface ComparisonExecutionOptions {
  prompt: string;
  model1: ComparisonModel;
  model2: ComparisonModel;
  readerRef: React.MutableRefObject<ReadableStreamDefaultReader<Uint8Array> | null>;
  model1Actions: ModelEventActions;
  model2Actions: ModelEventActions;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setStreaming: Dispatch<SetStateAction<boolean>>;
}

async function cancelActiveReader(
  readerRef: ComparisonExecutionOptions["readerRef"],
): Promise<void> {
  const reader = readerRef.current;
  readerRef.current = null;
  if (!reader) return;
  try {
    await reader.cancel();
  } catch {
    // The stream may already be closed.
  }
}

async function requestComparisonStream(
  prompt: string,
  model1: ComparisonModel,
  model2: ComparisonModel,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch("/api/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: prompt.trim(),
      model1Id: model1.modelId,
      model2Id: model2.modelId,
      model1Name: model1.name,
      model2Name: model2.name,
    }),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || "Failed to start comparison");
  }
  if (!response.headers.get("Content-Type")?.includes("text/event-stream")) {
    throw new Error("Expected SSE stream but received different content type");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Failed to get stream reader");
  return reader;
}

async function executeComparison(
  options: ComparisonExecutionOptions,
): Promise<void> {
  try {
    await cancelActiveReader(options.readerRef);
    const reader = await requestComparisonStream(
      options.prompt,
      options.model1,
      options.model2,
    );
    options.readerRef.current = reader;
    options.setLoading(false);
    await consumeDualStream(reader, (line) =>
      processDualStreamLine(
        line,
        options.model1.name ?? "First model",
        options.model2.name ?? "Second model",
        options.model1Actions,
        options.model2Actions,
      ),
    );
    options.model1Actions.setComplete(true);
    options.model2Actions.setComplete(true);
    options.setStreaming(false);
  } catch (error) {
    toast.error("Comparison Failed", {
      description:
        error instanceof Error ? error.message : "Failed to compare models",
    });
    options.setStreaming(false);
    options.setLoading(false);
  } finally {
    await cancelActiveReader(options.readerRef);
  }
}

function ComparisonHeader() {
  return (
    <div className="mb-6">
      <PageBranding />
      <h1 className="text-2xl font-semibold text-gray-900">Model Comparison</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Compare how different AI models respond to the same prompt
      </p>
    </div>
  );
}

function hasComparisonResponse(
  model1Response: string,
  model2Response: string,
  model1ImageUrl: string | undefined,
  model2ImageUrl: string | undefined,
): boolean {
  return Boolean(
    model1Response || model2Response || model1ImageUrl || model2ImageUrl,
  );
}

// Note: This component uses native streaming via Server-Sent Events
// Both text and image generation models are supported

export function ModelCompare() {
  // Use shared model management hooks (prefer chat models for auto-selection)
  const model1State = useModelsWithPersistence("compareModel1", ["chat"]);
  const model2State = useModelsWithPersistence("compareModel2", ["chat"]);

  const [prompt, setPrompt] = useState("");
  const [model1Response, setModel1Response] = useState("");
  const [model2Response, setModel2Response] = useState("");
  const [model1ImageUrl, setModel1ImageUrl] = useState<string | undefined>();
  const [model2ImageUrl, setModel2ImageUrl] = useState<string | undefined>();
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [model1Complete, setModel1Complete] = useState(false);
  const [model2Complete, setModel2Complete] = useState(false);
  const [model1Error, setModel1Error] = useState<string | undefined>();
  const [model2Error, setModel2Error] = useState<string | undefined>();

  // Memoize image model detection — isImageModel does JSON.parse on every call
  const model1IsImage = useMemo(
    () => isImageModel(model1State.selectedModel),
    [model1State.selectedModel],
  );
  const model2IsImage = useMemo(
    () => isImageModel(model2State.selectedModel),
    [model2State.selectedModel],
  );

  // Track active stream reader for cleanup
  const streamReaderRef =
    useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!model1State.selectedModel || !model2State.selectedModel) {
      toast.error("Select both models", {
        description: "Please select two models to compare",
      });
      return;
    }

    if (!prompt.trim()) {
      toast.error("Enter a prompt", {
        description: "Please enter a prompt to send to the models",
      });
      return;
    }

    if (model1State.selectedModel.id === model2State.selectedModel.id) {
      toast.error("Select different models", {
        description: "Please select two different models to compare",
      });
      return;
    }

    // Clear previous responses and start processing
    setModel1Response("");
    setModel2Response("");
    setModel1ImageUrl(undefined);
    setModel2ImageUrl(undefined);
    setModel1Error(undefined);
    setModel2Error(undefined);
    setModel1Complete(false);
    setModel2Complete(false);
    setIsLoading(true);
    setIsStreaming(true);

    await executeComparison({
      prompt,
      model1: model1State.selectedModel,
      model2: model2State.selectedModel,
      readerRef: streamReaderRef,
      model1Actions: {
        appendResponse: setModel1Response,
        setImageUrl: setModel1ImageUrl,
        setComplete: setModel1Complete,
        setError: setModel1Error,
      },
      model2Actions: {
        appendResponse: setModel2Response,
        setImageUrl: setModel2ImageUrl,
        setComplete: setModel2Complete,
        setError: setModel2Error,
      },
      setLoading: setIsLoading,
      setStreaming: setIsStreaming,
    });
  }, [model1State.selectedModel, model2State.selectedModel, prompt]);

  const handleNewComparison = useCallback(() => {
    cancelActiveReader(streamReaderRef);
    setModel1Response("");
    setModel2Response("");
    setModel1ImageUrl(undefined);
    setModel2ImageUrl(undefined);
    setModel1Error(undefined);
    setModel2Error(undefined);
    setPrompt("");
    setIsStreaming(false);
    setIsLoading(false);
    setModel1Complete(false);
    setModel2Complete(false);
  }, []);

  const handleStopStreaming = useCallback(() => {
    cancelActiveReader(streamReaderRef);
    setIsStreaming(false);
    setIsLoading(false);
    setModel1Complete(false);
    setModel2Complete(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelActiveReader(streamReaderRef);
    };
  }, []);

  const hasResponses = hasComparisonResponse(
    model1Response,
    model2Response,
    model1ImageUrl,
    model2ImageUrl,
  );

  return (
    <div className="flex h-full flex-col">
      <ComparisonHeader />

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
          hasResponses={hasResponses}
        />

        <div className="flex-1 overflow-hidden">
          <DualResponse
            model1={{
              model: model1State.selectedModel,
              response: model1Response,
              imageUrl: model1ImageUrl,
              isImageModel: model1IsImage,
              status: isStreaming && !model1Complete ? "streaming" : "ready",
              error: model1Error,
            }}
            model2={{
              model: model2State.selectedModel,
              response: model2Response,
              imageUrl: model2ImageUrl,
              isImageModel: model2IsImage,
              status: isStreaming && !model2Complete ? "streaming" : "ready",
              error: model2Error,
            }}
            onStopModel1={handleStopStreaming}
            onStopModel2={handleStopStreaming}
          />
        </div>
      </div>
    </div>
  );
}
