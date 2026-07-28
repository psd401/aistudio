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

function validateRequiredString(
  model: Record<string, unknown>,
  field: "name" | "modelId",
  prefix: string,
  errors: string[]
): void {
  const value = model[field]
  if (typeof value === "string" && value.trim()) return
  errors.push(
    `${prefix}: '${field}' is required and must be a non-empty string`
  )
}

function validateProvider(
  model: Record<string, unknown>,
  prefix: string,
  errors: string[]
): void {
  if (typeof model.provider !== "string" || !model.provider) {
    errors.push(`${prefix}: 'provider' is required`)
    return
  }
  if (!VALID_PROVIDERS_SET.has(model.provider)) {
    errors.push(
      `${prefix}: Invalid provider '${model.provider}'. Valid values: ${VALID_PROVIDERS.join(", ")}`
    )
  }
}

function validateStringArray(
  value: unknown,
  field: "capabilities" | "allowedRoles",
  prefix: string,
  errors: string[]
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${prefix}: '${field}' must be an array`)
    return
  }
  if (!value.every((entry) => typeof entry === "string")) {
    errors.push(`${prefix}: '${field}' must be an array of strings`)
  }
}

function validateOptionalScalars(
  model: Record<string, unknown>,
  prefix: string,
  errors: string[]
): void {
  if (
    model.description !== undefined
    && typeof model.description !== "string"
  ) {
    errors.push(`${prefix}: 'description' must be a string`)
  }
  if (model.maxTokens === undefined) return
  if (
    typeof model.maxTokens !== "number"
    || !Number.isInteger(model.maxTokens)
  ) {
    errors.push(`${prefix}: 'maxTokens' must be an integer`)
    return
  }
  if (model.maxTokens < 0) {
    errors.push(`${prefix}: 'maxTokens' must be non-negative`)
  }
}

function validateBooleanFields(
  model: Record<string, unknown>,
  prefix: string,
  errors: string[]
): void {
  const booleanFields = ["active", "nexusEnabled", "architectEnabled"] as const
  for (const field of booleanFields) {
    if (model[field] !== undefined && typeof model[field] !== "boolean") {
      errors.push(`${prefix}: '${field}' must be a boolean`)
    }
  }
}

function validatePricingFields(
  model: Record<string, unknown>,
  prefix: string,
  errors: string[]
): void {
  const pricingFields = [
    "inputCostPer1kTokens",
    "outputCostPer1kTokens",
    "cachedInputCostPer1kTokens",
  ] as const
  for (const field of pricingFields) {
    const value = model[field]
    if (value === undefined) continue
    if (typeof value !== "string" && typeof value !== "number") {
      errors.push(`${prefix}: '${field}' must be a number or string`)
      continue
    }
    const numericValue = Number(value)
    if (Number.isNaN(numericValue) || numericValue < 0) {
      errors.push(
        `${prefix}: '${field}' must be a valid non-negative number`
      )
    }
  }
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

  validateRequiredString(m, "name", prefix, modelErrors)
  validateRequiredString(m, "modelId", prefix, modelErrors)
  validateProvider(m, prefix, modelErrors)
  validateOptionalScalars(m, prefix, modelErrors)
  validateStringArray(m.capabilities, "capabilities", prefix, modelErrors)
  // allowedRoles becomes resource grants after import, but malformed values
  // must still fail loudly instead of silently widening access.
  validateStringArray(m.allowedRoles, "allowedRoles", prefix, modelErrors)
  validateBooleanFields(m, prefix, modelErrors)
  validatePricingFields(m, prefix, modelErrors)

  return {
    valid: modelErrors.length === 0,
    errors: modelErrors,
  };
}
