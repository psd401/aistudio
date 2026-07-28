import {
  inferModelFamily,
  isExecutableTextModel,
  modelSupportsProviderNativeTool,
} from "@/lib/ai/model-router/core";
import {
  getAIModelById,
  getArchitectEnabledModels,
} from "@/lib/db/drizzle/ai-models";
import { filterAccessibleResourceIds } from "@/lib/db/drizzle/resource-access";
import type {
  AssistantModelFamily,
  AssistantModelRoutingMode,
} from "@/lib/db/schema/tables/assistant-architects";
import {
  getAllTools,
  getAvailableToolsForModel,
} from "@/lib/tools/tool-registry";

export interface PromptToolValidationResult {
  isValid: boolean;
  invalidTools: string[];
  message?: string;
}

interface PromptToolRoutingConfig {
  modelRoutingMode: AssistantModelRoutingMode | null | undefined;
  modelRoutingFamily: AssistantModelFamily | null | undefined;
}

async function validateToolsForModel(
  enabledTools: string[],
  modelId: number,
): Promise<PromptToolValidationResult> {
  if (enabledTools.length === 0) {
    return { isValid: true, invalidTools: [] };
  }

  try {
    const model = await getAIModelById(modelId);
    if (!model || !model.active) {
      return {
        isValid: false,
        invalidTools: enabledTools,
        message: "Model not found or inactive",
      };
    }

    const availableToolNames = new Set(
      (await getAvailableToolsForModel(model.modelId)).map((tool) => tool.name),
    );
    const knownToolNames = new Set(getAllTools().map((tool) => tool.name));
    const unknownTools = enabledTools.filter(
      (toolName) => !knownToolNames.has(toolName),
    );
    if (unknownTools.length > 0) {
      return {
        isValid: false,
        invalidTools: unknownTools,
        message: `Unknown tools: ${unknownTools.join(", ")}`,
      };
    }

    const unavailableTools = enabledTools.filter(
      (toolName) => !availableToolNames.has(toolName),
    );
    return unavailableTools.length > 0
      ? {
          isValid: false,
          invalidTools: unavailableTools,
          message: `Tools not supported by this model: ${unavailableTools.join(", ")}`,
        }
      : { isValid: true, invalidTools: [] };
  } catch {
    return {
      isValid: false,
      invalidTools: enabledTools,
      // This validation result can cross REST/MCP boundaries. Do not reflect
      // database, provider, or catalog exception details to the caller.
      message: "Unable to validate prompt tools",
    };
  }
}

/**
 * Validate per-prompt tools using the same routing semantics as the editor.
 * Import, fork, and ordinary prompt mutation all call this shared boundary.
 */
export async function validatePromptToolsForRouting(
  enabledTools: string[],
  routing: PromptToolRoutingConfig,
  authorUserId: number,
  fallbackModelId: number | null | undefined,
): Promise<PromptToolValidationResult> {
  const routingMode = routing.modelRoutingMode ?? "legacy";
  if (routingMode === "legacy") {
    if (!fallbackModelId) {
      return {
        isValid: false,
        invalidTools: enabledTools,
        message: "Choose a model before enabling tools",
      };
    }
    return validateToolsForModel(enabledTools, fallbackModelId);
  }
  if (enabledTools.length === 0) {
    return { isValid: true, invalidTools: [] };
  }

  const knownTools = new Set(getAllTools().map((tool) => tool.name));
  const unknownTools = enabledTools.filter((tool) => !knownTools.has(tool));
  if (unknownTools.length > 0) {
    return {
      isValid: false,
      invalidTools: unknownTools,
      message: `Unknown tools: ${unknownTools.join(", ")}`,
    };
  }

  const models = (await getArchitectEnabledModels()).filter(
    (model) =>
      isExecutableTextModel(model) &&
      (routingMode !== "advanced" ||
        inferModelFamily(model) === routing.modelRoutingFamily),
  );
  const accessibleIds = await filterAccessibleResourceIds(
    authorUserId,
    "model",
    models.map((model) => model.id),
  );
  const accessible = models.filter((model) =>
    accessibleIds.has(String(model.id)),
  );
  const availableByModel = await Promise.all(
    accessible.map(
      async (model) =>
        new Set(
          (await getAvailableToolsForModel(model.modelId))
            .filter((tool) =>
              modelSupportsProviderNativeTool(model, tool.name),
            )
            .map((tool) => tool.name),
        ),
    ),
  );
  if (
    availableByModel.some((tools) =>
      enabledTools.every((tool) => tools.has(tool)),
    )
  ) {
    return { isValid: true, invalidTools: [] };
  }
  return {
    isValid: false,
    invalidTools: enabledTools,
    message:
      "No accessible model in this routing mode supports all selected tools",
  };
}
