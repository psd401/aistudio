/**
 * Agent tool: `images.generate` (Issue #926).
 *
 * Generates an image from a text prompt by resolving the platform's configured
 * image-capable model and delegating to the existing `generateImageForNexus`
 * service (the same code path Nexus chat uses — no second implementation). Returns
 * a URL to the stored image so the model can reference it in its answer.
 */

import type { McpToolHandler, McpToolResult } from "@/lib/mcp/types";
import { createLogger } from "@/lib/logger";
import { getAIModels } from "@/lib/db/drizzle/ai-models";
import { hasCapability } from "@/lib/ai/capability-utils";
import { generateImageForNexus } from "@/lib/ai/image-generation-service";

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Pick the image-generation model for an agent run: the first active model that
 * declares the `imageGeneration` capability on a supported provider (openai or
 * google). Returns null when the deployment has no image model configured.
 *
 * Not cached on purpose: this resolves with one indexed `ai_models` query whose
 * latency is negligible next to the multi-second image-generation API call it
 * precedes, so a module-level cache would add staleness + shared mutable state for
 * no meaningful gain. (Correctness review — considered and intentionally skipped.)
 */
async function resolveImageModel(): Promise<
  { modelId: string; provider: "openai" | "google" } | null
> {
  const models = await getAIModels();
  const candidate = models.find(
    (m) =>
      m.active &&
      (m.provider === "openai" || m.provider === "google") &&
      hasCapability(m.capabilities, "imageGeneration")
  );
  if (!candidate) return null;
  return {
    modelId: candidate.modelId,
    provider: candidate.provider as "openai" | "google",
  };
}

export const handleGenerateImage: McpToolHandler = async (args, context) => {
  const log = createLogger({
    requestId: context.requestId,
    action: "agent.generate_image",
  });

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return textResult("Missing required field: prompt", true);
  }
  const size = typeof args.size === "string" ? args.size : undefined;

  const model = await resolveImageModel();
  if (!model) {
    log.warn("No image-capable model configured for agent image generation");
    return textResult(
      "Image generation is not available: no image-capable model is configured " +
        "for this deployment.",
      true
    );
  }

  try {
    const result = await generateImageForNexus({
      prompt,
      modelId: model.modelId,
      provider: model.provider,
      // No conversation context in an agent tool call; scope the S3 key to the
      // request so generated assets are still traceable.
      conversationId: `agent-${context.requestId}`,
      userId: String(context.userId),
      size,
    });

    log.info("Agent image generated", {
      provider: result.provider,
      model: result.model,
      s3Key: result.s3Key,
    });

    return textResult(
      JSON.stringify({
        imageUrl: result.imageUrl,
        model: result.model,
        provider: result.provider,
        ...(result.altText ? { altText: result.altText } : {}),
        ...(result.dimensions ? { dimensions: result.dimensions } : {}),
        note: "The image URL is a time-limited link to the generated image.",
      })
    );
  } catch (err) {
    // generateImageForNexus throws typed errors ({ type, message, ... }).
    const typed = err as { type?: string; message?: string };
    const message =
      typed?.message || (err instanceof Error ? err.message : String(err));
    log.error("Agent image generation failed", {
      type: typed?.type,
      error: message,
    });
    return textResult(`Image generation failed: ${message}`, true);
  }
};
