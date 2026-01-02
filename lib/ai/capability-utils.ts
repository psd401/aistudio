/**
 * AI Model Capability Utilities
 *
 * Helpers for working with the capabilities text/JSON array field.
 * Consolidates the dual capability fields (nexus_capabilities JSONB and capabilities TEXT)
 * into a single source of truth using the capabilities field.
 *
 * Part of Issue #594 - Eliminate nexus_capabilities field
 *
 * Capability mapping (snake_case in DB -> camelCase in runtime):
 * - "web_search" -> webSearch
 * - "code_interpreter" -> codeInterpreter
 * - "code_execution" -> codeExecution
 * - "canvas" -> canvas
 * - "grounding" -> grounding
 * - "thinking" -> thinking
 * - "reasoning" -> reasoning
 * - "artifacts" -> artifacts
 * - "responses_api" -> responsesAPI
 * - "prompt_caching" -> promptCaching
 * - "context_caching" -> contextCaching
 * - "computer_use" -> computerUse
 * - "workspace_tools" -> workspaceTools
 * - "image_generation" -> imageGeneration
 *
 * @example
 * ```typescript
 * import { hasCapability, parseCapabilities } from '@/lib/ai/capability-utils';
 *
 * // Check if model has a capability
 * const model = await getAIModelByModelId('gpt-4');
 * if (hasCapability(model.capabilities, 'webSearch')) {
 *   // Enable web search tool
 * }
 *
 * // Parse all capabilities to a Set
 * const caps = parseCapabilities(model.capabilities);
 * if (caps.has('reasoning')) {
 *   // Model supports advanced reasoning
 * }
 * ```
 */

/**
 * Valid capability names (camelCase for runtime use)
 */
export type CapabilityKey =
  | "webSearch"
  | "codeInterpreter"
  | "codeExecution"
  | "canvas"
  | "grounding"
  | "thinking"
  | "reasoning"
  | "artifacts"
  | "responsesAPI"
  | "promptCaching"
  | "contextCaching"
  | "computerUse"
  | "workspaceTools"
  | "imageGeneration";

/**
 * Database capability values (snake_case as stored in capabilities field)
 */
export type DatabaseCapability =
  | "web_search"
  | "code_interpreter"
  | "code_execution"
  | "canvas"
  | "grounding"
  | "thinking"
  | "reasoning"
  | "artifacts"
  | "responses_api"
  | "prompt_caching"
  | "context_caching"
  | "computer_use"
  | "workspace_tools"
  | "image_generation";

/**
 * Mapping from database snake_case to runtime camelCase
 */
const DB_TO_RUNTIME_MAP: Record<DatabaseCapability, CapabilityKey> = {
  web_search: "webSearch",
  code_interpreter: "codeInterpreter",
  code_execution: "codeExecution",
  canvas: "canvas",
  grounding: "grounding",
  thinking: "thinking",
  reasoning: "reasoning",
  artifacts: "artifacts",
  responses_api: "responsesAPI",
  prompt_caching: "promptCaching",
  context_caching: "contextCaching",
  computer_use: "computerUse",
  workspace_tools: "workspaceTools",
  image_generation: "imageGeneration",
};

/**
 * Reverse mapping: runtime camelCase to database snake_case
 */
const RUNTIME_TO_DB_MAP: Record<CapabilityKey, DatabaseCapability> =
  Object.entries(DB_TO_RUNTIME_MAP).reduce(
    (acc, [dbKey, runtimeKey]) => {
      acc[runtimeKey] = dbKey as DatabaseCapability;
      return acc;
    },
    {} as Record<CapabilityKey, DatabaseCapability>
  );

/**
 * Set of valid database capability values for validation
 */
const VALID_DB_CAPABILITIES = new Set<string>(Object.keys(DB_TO_RUNTIME_MAP));

/**
 * Parse capabilities from database format to runtime Set
 *
 * The capabilities field can be:
 * - A JSON string like '["web_search", "canvas"]'
 * - An array of strings like ["web_search", "canvas"]
 * - null or undefined
 *
 * @param capabilities - Raw capabilities from database
 * @returns Set of camelCase capability keys
 */
export function parseCapabilities(
  capabilities: string | string[] | null | undefined
): Set<CapabilityKey> {
  const result = new Set<CapabilityKey>();

  if (!capabilities) {
    return result;
  }

  let parsed: unknown;

  // Handle string (JSON) or array
  if (typeof capabilities === "string") {
    // Handle empty string
    if (capabilities.trim() === "") {
      return result;
    }

    try {
      parsed = JSON.parse(capabilities);
    } catch {
      // If JSON parse fails, return empty set
      return result;
    }
  } else {
    parsed = capabilities;
  }

  // Must be an array
  if (!Array.isArray(parsed)) {
    return result;
  }

  // Map valid capabilities to runtime format
  for (const cap of parsed) {
    if (typeof cap !== "string") {
      continue;
    }

    const normalized = cap.toLowerCase().trim();

    // Check if it's a valid database capability
    if (VALID_DB_CAPABILITIES.has(normalized)) {
      const runtimeKey = DB_TO_RUNTIME_MAP[normalized as DatabaseCapability];
      result.add(runtimeKey);
    }
  }

  return result;
}

/**
 * Check if capabilities include a specific capability
 *
 * @param capabilities - Raw capabilities from database (string JSON or array)
 * @param capability - Capability to check (camelCase)
 * @returns true if capability exists
 *
 * @example
 * ```typescript
 * if (hasCapability(model.capabilities, 'webSearch')) {
 *   enableWebSearchTool();
 * }
 * ```
 */
export function hasCapability(
  capabilities: string | string[] | null | undefined,
  capability: CapabilityKey
): boolean {
  const parsed = parseCapabilities(capabilities);
  return parsed.has(capability);
}

/**
 * Check if capabilities include ANY of the specified capabilities (OR logic)
 *
 * @param capabilities - Raw capabilities from database
 * @param requiredCapabilities - Array of capabilities to check
 * @returns true if at least one capability exists
 *
 * @example
 * ```typescript
 * // Check if model has advanced features
 * if (hasAnyCapability(model.capabilities, ['reasoning', 'thinking', 'artifacts'])) {
 *   // Model is suitable for quality-priority requests
 * }
 * ```
 */
export function hasAnyCapability(
  capabilities: string | string[] | null | undefined,
  requiredCapabilities: CapabilityKey[]
): boolean {
  const parsed = parseCapabilities(capabilities);
  return requiredCapabilities.some((cap) => parsed.has(cap));
}

/**
 * Check if capabilities include ALL of the specified capabilities (AND logic)
 *
 * @param capabilities - Raw capabilities from database
 * @param requiredCapabilities - Array of capabilities to check
 * @returns true if all capabilities exist
 *
 * @example
 * ```typescript
 * // Check if model has all required features
 * if (hasAllCapabilities(model.capabilities, ['webSearch', 'codeInterpreter'])) {
 *   // Model supports both tools
 * }
 * ```
 */
export function hasAllCapabilities(
  capabilities: string | string[] | null | undefined,
  requiredCapabilities: CapabilityKey[]
): boolean {
  const parsed = parseCapabilities(capabilities);
  return requiredCapabilities.every((cap) => parsed.has(cap));
}

/**
 * Convert runtime capabilities to database format for storage
 *
 * @param capabilities - Set or array of camelCase capabilities
 * @returns Array of snake_case strings for database storage
 *
 * @example
 * ```typescript
 * const dbCapabilities = serializeCapabilities(['webSearch', 'canvas']);
 * // Returns: ['web_search', 'canvas']
 * ```
 */
export function serializeCapabilities(
  capabilities: Set<CapabilityKey> | CapabilityKey[]
): DatabaseCapability[] {
  const capArray = Array.isArray(capabilities)
    ? capabilities
    : Array.from(capabilities);
  return capArray
    .map((cap) => RUNTIME_TO_DB_MAP[cap])
    .filter((cap): cap is DatabaseCapability => cap !== undefined);
}

/**
 * Convert runtime capabilities to JSON string for database storage
 *
 * @param capabilities - Set or array of camelCase capabilities
 * @returns JSON string of snake_case capabilities
 *
 * @example
 * ```typescript
 * const jsonCapabilities = serializeCapabilitiesToJSON(['webSearch', 'canvas']);
 * // Returns: '["web_search","canvas"]'
 * ```
 */
export function serializeCapabilitiesToJSON(
  capabilities: Set<CapabilityKey> | CapabilityKey[]
): string {
  return JSON.stringify(serializeCapabilities(capabilities));
}

/**
 * Get all valid capability names (for UI selection, validation, etc.)
 *
 * @returns Array of all valid camelCase capability names
 */
export function getAllCapabilityKeys(): CapabilityKey[] {
  return Object.values(DB_TO_RUNTIME_MAP);
}

/**
 * Get all valid database capability names
 *
 * @returns Array of all valid snake_case capability names
 */
export function getAllDatabaseCapabilities(): DatabaseCapability[] {
  return Object.keys(DB_TO_RUNTIME_MAP) as DatabaseCapability[];
}

/**
 * Validate if a string is a valid database capability
 *
 * @param capability - String to validate
 * @returns true if valid database capability
 */
export function isValidDatabaseCapability(
  capability: string
): capability is DatabaseCapability {
  return VALID_DB_CAPABILITIES.has(capability.toLowerCase().trim());
}

/**
 * Convert a single capability from database to runtime format
 *
 * @param dbCapability - Database capability (snake_case)
 * @returns Runtime capability (camelCase) or undefined if invalid
 */
export function toRuntimeCapability(
  dbCapability: string
): CapabilityKey | undefined {
  const normalized = dbCapability.toLowerCase().trim();
  if (VALID_DB_CAPABILITIES.has(normalized)) {
    return DB_TO_RUNTIME_MAP[normalized as DatabaseCapability];
  }
  return undefined;
}

/**
 * Convert a single capability from runtime to database format
 *
 * @param runtimeCapability - Runtime capability (camelCase)
 * @returns Database capability (snake_case) or undefined if invalid
 */
export function toDatabaseCapability(
  runtimeCapability: CapabilityKey
): DatabaseCapability | undefined {
  return RUNTIME_TO_DB_MAP[runtimeCapability];
}
