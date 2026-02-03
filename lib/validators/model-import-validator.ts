/**
 * Shared AI Model Import Validation
 *
 * Centralized validation logic for JSON model imports.
 * Used by both client-side (for immediate UX feedback) and server-side (for security).
 */

import { VALID_PROVIDERS } from "@/lib/constants/providers";

// Valid provider values (Set for O(1) lookup)
const VALID_PROVIDERS_SET: Set<string> = new Set(VALID_PROVIDERS as readonly string[]);

/**
 * Validation result for a single model
 */
export interface ModelValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a single model object against schema requirements
 * @param model - The model object to validate
 * @param index - Index in the array (for error messages)
 * @returns Validation result with any errors found
 */
export function validateModel(
  model: unknown,
  index: number
): ModelValidationResult {
  const modelErrors: string[] = [];
  const prefix = `Model ${index + 1}`;

  if (!model || typeof model !== "object") {
    return { valid: false, errors: [`${prefix}: Must be an object`] };
  }

  const m = model as Record<string, unknown>;

  // Required fields
  if (!m.name || typeof m.name !== "string" || !(m.name as string).trim()) {
    modelErrors.push(
      `${prefix}: 'name' is required and must be a non-empty string`
    );
  }

  if (
    !m.modelId ||
    typeof m.modelId !== "string" ||
    !(m.modelId as string).trim()
  ) {
    modelErrors.push(
      `${prefix}: 'modelId' is required and must be a non-empty string`
    );
  }

  if (!m.provider || typeof m.provider !== "string") {
    modelErrors.push(`${prefix}: 'provider' is required`);
  } else if (!VALID_PROVIDERS_SET.has(m.provider)) {
    modelErrors.push(
      `${prefix}: Invalid provider '${m.provider}'. Valid values: ${VALID_PROVIDERS.join(", ")}`
    );
  }

  // Optional field type validation
  if (m.description !== undefined && typeof m.description !== "string") {
    modelErrors.push(`${prefix}: 'description' must be a string`);
  }

  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) {
      modelErrors.push(`${prefix}: 'capabilities' must be an array`);
    } else if (
      !(m.capabilities as unknown[]).every((c) => typeof c === "string")
    ) {
      modelErrors.push(`${prefix}: 'capabilities' must be an array of strings`);
    }
  }

  if (m.maxTokens !== undefined) {
    if (typeof m.maxTokens !== "number" || !Number.isInteger(m.maxTokens)) {
      modelErrors.push(`${prefix}: 'maxTokens' must be an integer`);
    } else if ((m.maxTokens as number) < 0) {
      modelErrors.push(`${prefix}: 'maxTokens' must be non-negative`);
    }
  }

  // Boolean fields
  const booleanFields = ["active", "nexusEnabled", "architectEnabled"] as const;
  for (const field of booleanFields) {
    if (m[field] !== undefined && typeof m[field] !== "boolean") {
      modelErrors.push(`${prefix}: '${field}' must be a boolean`);
    }
  }

  // Array fields
  if (m.allowedRoles !== undefined) {
    if (!Array.isArray(m.allowedRoles)) {
      modelErrors.push(`${prefix}: 'allowedRoles' must be an array`);
    } else if (
      !(m.allowedRoles as unknown[]).every((r) => typeof r === "string")
    ) {
      modelErrors.push(`${prefix}: 'allowedRoles' must be an array of strings`);
    }
  }

  // Pricing fields (string numbers)
  const pricingFields = [
    "inputCostPer1kTokens",
    "outputCostPer1kTokens",
    "cachedInputCostPer1kTokens",
  ] as const;
  for (const field of pricingFields) {
    if (m[field] !== undefined) {
      const value = m[field];
      if (typeof value !== "string" && typeof value !== "number") {
        modelErrors.push(`${prefix}: '${field}' must be a number or string`);
      } else {
        const num = Number(value);
        if (Number.isNaN(num) || num < 0) {
          modelErrors.push(
            `${prefix}: '${field}' must be a valid non-negative number`
          );
        }
      }
    }
  }

  return {
    valid: modelErrors.length === 0,
    errors: modelErrors,
  };
}
