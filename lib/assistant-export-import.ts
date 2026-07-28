import {
  executeQuery,
  type DbTransaction,
} from "@/lib/db/drizzle-client"
import { inArray, eq } from "drizzle-orm"
import {
  assistantArchitects,
  chainPrompts,
  toolInputFields,
  aiModels,
  type AssistantArchitectMode,
  type AssistantModelFamily,
  type AssistantModelRoutingMode,
  type AssistantRetrievalScope,
} from "@/lib/db/schema"
import logger from "@/lib/logger"
export interface ExportedAssistant {
  name: string
  description: string
  status: string
  image_path?: string | null
  is_parallel?: boolean
  timeout_seconds?: number | null
  mode?: AssistantArchitectMode
  model_routing_mode?: AssistantModelRoutingMode
  model_routing_family?: AssistantModelFamily | null
  agent_enabled_tools?: string[]
  agent_enabled_connectors?: string[]
  agent_max_steps?: number
  agent_timeout_seconds?: number
  agent_cost_cap_cents?: number | null
  agent_max_requests_per_hour?: number | null
  retrieval_scope?: AssistantRetrievalScope | null
  prompts: Array<{
    name: string
    content: string
    system_context?: string | null
    model_name: string // Using model name instead of ID for portability
    position: number
    parallel_group?: number | null
    input_mapping?: Record<string, string> | null
    timeout_seconds?: number | null
    repository_ids?: number[]
    enabled_tools?: string[]
  }>
  input_fields: Array<{
    name: string
    label: string
    field_type: string
    position: number
    options?: Record<string, unknown> | null
  }>
}

export interface ExportFormat {
  version: string
  exported_at: string
  export_source?: string
  assistants: ExportedAssistant[]
}

export const CURRENT_EXPORT_VERSION = "1.0"

/**
 * Fetches complete assistant data including prompts and input fields
 */
async function runExportQuery<T>(
  transaction: DbTransaction | undefined,
  query: (db: Pick<DbTransaction, "select">) => Promise<T>,
  context: string
): Promise<T> {
  return transaction
    ? query(transaction)
    : executeQuery((db) => query(db), context)
}

export async function getAssistantDataForExport(
  assistantIds: number[],
  transaction?: DbTransaction
): Promise<ExportedAssistant[]> {
  if (assistantIds.length === 0) return []

  // Fetch assistants
  const assistants = await runExportQuery(
    transaction,
    (db) => db.select({
      id: assistantArchitects.id,
      name: assistantArchitects.name,
      description: assistantArchitects.description,
      status: assistantArchitects.status,
      imagePath: assistantArchitects.imagePath,
      isParallel: assistantArchitects.isParallel,
      timeoutSeconds: assistantArchitects.timeoutSeconds,
      mode: assistantArchitects.mode,
      modelRoutingMode: assistantArchitects.modelRoutingMode,
      modelRoutingFamily: assistantArchitects.modelRoutingFamily,
      agentEnabledTools: assistantArchitects.agentEnabledTools,
      agentEnabledConnectors: assistantArchitects.agentEnabledConnectors,
      agentMaxSteps: assistantArchitects.agentMaxSteps,
      agentTimeoutSeconds: assistantArchitects.agentTimeoutSeconds,
      agentCostCapCents: assistantArchitects.agentCostCapCents,
      agentMaxRequestsPerHour: assistantArchitects.agentMaxRequestsPerHour,
      retrievalScope: assistantArchitects.retrievalScope,
    })
    .from(assistantArchitects)
    .where(inArray(assistantArchitects.id, assistantIds)),
    "getAssistantsForExport"
  )

  // For each assistant, fetch related data
  const exportedAssistants = await Promise.all(assistants.map(async (assistant) => {
    // Fetch prompts with model information
    const prompts = await runExportQuery(
      transaction,
      (db) => db.select({
        name: chainPrompts.name,
        content: chainPrompts.content,
        systemContext: chainPrompts.systemContext,
        position: chainPrompts.position,
        parallelGroup: chainPrompts.parallelGroup,
        inputMapping: chainPrompts.inputMapping,
        timeoutSeconds: chainPrompts.timeoutSeconds,
        repositoryIds: chainPrompts.repositoryIds,
        enabledTools: chainPrompts.enabledTools,
        modelName: aiModels.modelId
      })
      .from(chainPrompts)
      .leftJoin(aiModels, eq(chainPrompts.modelId, aiModels.id))
      .where(eq(chainPrompts.assistantArchitectId, assistant.id))
      .orderBy(chainPrompts.position),
      "getPromptsForExport"
    )

    // Fetch input fields
    const inputFields = await runExportQuery(
      transaction,
      (db) => db.select({
        name: toolInputFields.name,
        label: toolInputFields.label,
        fieldType: toolInputFields.fieldType,
        position: toolInputFields.position,
        options: toolInputFields.options
      })
      .from(toolInputFields)
      .where(eq(toolInputFields.assistantArchitectId, assistant.id))
      .orderBy(toolInputFields.position),
      "getInputFieldsForExport"
    )

    return {
      name: assistant.name,
      description: assistant.description || '',
      status: assistant.status,
      image_path: assistant.imagePath ?? undefined,
      is_parallel: assistant.isParallel ?? undefined,
      timeout_seconds: assistant.timeoutSeconds ?? undefined,
      mode: assistant.mode,
      model_routing_mode: assistant.modelRoutingMode,
      model_routing_family: assistant.modelRoutingFamily ?? undefined,
      agent_enabled_tools: assistant.agentEnabledTools,
      agent_enabled_connectors: assistant.agentEnabledConnectors,
      agent_max_steps: assistant.agentMaxSteps,
      agent_timeout_seconds: assistant.agentTimeoutSeconds,
      agent_cost_cap_cents: assistant.agentCostCapCents ?? undefined,
      agent_max_requests_per_hour: assistant.agentMaxRequestsPerHour ?? undefined,
      retrieval_scope: assistant.retrievalScope ?? undefined,
      prompts: prompts.map(p => ({
        name: p.name,
        content: p.content,
        system_context: p.systemContext ?? undefined,
        model_name: p.modelName || 'gpt-4', // Default fallback
        position: p.position,
        parallel_group: p.parallelGroup ?? undefined,
        input_mapping: p.inputMapping ?? undefined,
        timeout_seconds: p.timeoutSeconds ?? undefined,
        repository_ids: p.repositoryIds ?? [],
        enabled_tools: p.enabledTools ?? []
      })),
      input_fields: inputFields.map(f => ({
        name: f.name,
        label: f.label,
        field_type: f.fieldType,
        position: f.position,
        options: f.options ?? undefined
      }))
    }
  }))

  return exportedAssistants
}

/**
 * Creates the export JSON structure
 */
export function createExportFile(assistants: ExportedAssistant[]): ExportFormat {
  return {
    version: CURRENT_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    export_source: process.env.NEXT_PUBLIC_APP_NAME || "AI Studio",
    assistants
  }
}

// Max values mirror the runtime limits in assistant-execution-service.ts
const IMPORT_MAX_ASSISTANT_NAME_LENGTH = 255
const IMPORT_MAX_PROMPT_CONTENT_LENGTH = 10_000_000
const IMPORT_MAX_PROMPTS_PER_ASSISTANT = 20
// Mirrors MAX_INPUT_FIELDS in assistant-execution-service.ts: an assistant above
// this bound could never execute, and insertImportedFields issues one awaited
// insert per field inside the import transaction.
const IMPORT_MAX_INPUT_FIELDS_PER_ASSISTANT = 50
export const ASSISTANT_IMPORT_MAX_ASSISTANTS = 100
export const ASSISTANT_IMPORT_MAX_REPOSITORY_BINDINGS = 500
const IMPORTED_FIELD_TYPES = new Set([
  "short_text",
  "long_text",
  "select",
  "multi_select",
  "file_upload",
])
const ASSISTANT_MODES = new Set(["prompt_chain", "agentic"])
const MODEL_ROUTING_MODES = new Set(["legacy", "standard", "advanced"])
const MODEL_ROUTING_FAMILIES = new Set(["openai", "anthropic", "google"])
const RETRIEVAL_VISIBILITY_LEVELS = new Set([
  "private",
  "group",
  "internal",
  "public",
])
export const ASSISTANT_IMPORT_MAX_BYTES = 10 * 1024 * 1024

function validateImportCollectionLimits(
  assistants: unknown[]
): string | undefined {
  if (assistants.length === 0) {
    return "Import envelope must contain at least one assistant"
  }
  if (assistants.length > ASSISTANT_IMPORT_MAX_ASSISTANTS) {
    return `Too many assistants (maximum ${ASSISTANT_IMPORT_MAX_ASSISTANTS})`
  }

  let repositoryBindingCount = 0
  for (const assistant of assistants) {
    if (!assistant || typeof assistant !== "object" || Array.isArray(assistant)) {
      continue
    }
    const prompts = (assistant as Record<string, unknown>).prompts
    if (!Array.isArray(prompts)) continue
    for (const prompt of prompts) {
      if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
        continue
      }
      const repositoryIds = (prompt as Record<string, unknown>).repository_ids
      if (!Array.isArray(repositoryIds)) continue
      repositoryBindingCount += repositoryIds.length
      if (repositoryBindingCount > ASSISTANT_IMPORT_MAX_REPOSITORY_BINDINGS) {
        return (
          "Too many repository bindings " +
          `(maximum ${ASSISTANT_IMPORT_MAX_REPOSITORY_BINDINGS})`
        )
      }
    }
  }
  return undefined
}

function validateSerializedImportSize(data: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(data)
    if (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength >
        ASSISTANT_IMPORT_MAX_BYTES
    ) {
      return "Import payload too large (maximum 10 MB)"
    }
  } catch {
    return "Invalid file format"
  }
  return undefined
}

function isOptionalNullableInteger(
  value: unknown,
  minimum: number,
  maximum?: number
): boolean {
  return value === undefined ||
    value === null ||
    (Number.isInteger(value) &&
      Number(value) >= minimum &&
      (maximum === undefined || Number(value) <= maximum))
}

function isOptionalInteger(
  value: unknown,
  minimum: number,
  maximum?: number
): boolean {
  return value === undefined ||
    (Number.isInteger(value) &&
      Number(value) >= minimum &&
      (maximum === undefined || Number(value) <= maximum))
}

function validatePromptRepositories(
  assistantName: string,
  prompt: Record<string, unknown>
): string | undefined {
  if (
    prompt.repository_ids !== undefined &&
    (!Array.isArray(prompt.repository_ids) ||
      !prompt.repository_ids.every(
        repositoryId => Number.isInteger(repositoryId) && Number(repositoryId) > 0
      ))
  ) {
    return `Assistant ${assistantName}: prompt repository_ids must contain positive integers`
  }
  return undefined
}

function validatePromptTools(
  assistantName: string,
  prompt: Record<string, unknown>
): string | undefined {
  if (
    prompt.enabled_tools !== undefined &&
    (!Array.isArray(prompt.enabled_tools) ||
      !prompt.enabled_tools.every(tool => typeof tool === "string"))
  ) {
    return `Assistant ${assistantName}: prompt enabled_tools must contain strings`
  }
  return undefined
}

function validatePromptInputMapping(
  assistantName: string,
  prompt: Record<string, unknown>
): string | undefined {
  if (
    prompt.input_mapping !== undefined &&
    prompt.input_mapping !== null &&
    (typeof prompt.input_mapping !== "object" ||
      Array.isArray(prompt.input_mapping) ||
      !Object.values(prompt.input_mapping).every(value => typeof value === "string"))
  ) {
    return `Assistant ${assistantName}: prompt input_mapping must contain string values`
  }
  return undefined
}

function validatePromptScalarConfiguration(
  assistantName: string,
  prompt: Record<string, unknown>
): string | undefined {
  if (
    prompt.system_context !== undefined &&
    prompt.system_context !== null &&
    typeof prompt.system_context !== "string"
  ) {
    return `Assistant ${assistantName}: prompt system_context must be a string or null`
  }
  if (
    prompt.parallel_group !== undefined &&
    prompt.parallel_group !== null &&
    !Number.isInteger(prompt.parallel_group)
  ) {
    return `Assistant ${assistantName}: prompt parallel_group must be an integer or null`
  }
  if (!isOptionalNullableInteger(prompt.timeout_seconds, 1)) {
    return `Assistant ${assistantName}: prompt timeout_seconds must be a positive integer or null`
  }
  return undefined
}

function validateImportedPrompt(
  assistantName: string,
  prompt: unknown
): string | undefined {
  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
    return `Assistant ${assistantName}: invalid prompt`
  }
  const promptData = prompt as Record<string, unknown>
  if (
    typeof promptData.name !== "string" ||
    typeof promptData.content !== "string" ||
    typeof promptData.model_name !== "string" ||
    !Number.isInteger(promptData.position)
  ) {
    return `Assistant ${assistantName}: prompt is missing required fields`
  }
  const configurationError =
    validatePromptScalarConfiguration(assistantName, promptData) ??
    validatePromptRepositories(assistantName, promptData) ??
    validatePromptTools(assistantName, promptData) ??
    validatePromptInputMapping(assistantName, promptData)
  if (configurationError) return configurationError
  const oversizedFields = ["content", "system_context"].filter(field => {
    const value = promptData[field]
    return typeof value === "string" && value.length > IMPORT_MAX_PROMPT_CONTENT_LENGTH
  })

  if (oversizedFields.length === 0) return undefined
  return `Assistant ${assistantName}: prompt ${oversizedFields[0]} too large (max ${IMPORT_MAX_PROMPT_CONTENT_LENGTH} characters)`
}

function validateImportedPrompts(
  assistantName: string,
  prompts: unknown
): string | undefined {
  if (!Array.isArray(prompts)) {
    return `Invalid assistant ${assistantName}: missing prompts array`
  }
  if (prompts.length > IMPORT_MAX_PROMPTS_PER_ASSISTANT) {
    return `Assistant ${assistantName}: too many prompts (max ${IMPORT_MAX_PROMPTS_PER_ASSISTANT})`
  }
  for (const prompt of prompts) {
    const promptError = validateImportedPrompt(assistantName, prompt)
    if (promptError) return promptError
  }
  return undefined
}

function validateImportedInputFieldOptions(
  assistantName: string,
  options: unknown
): string | undefined {
  if (
    options !== undefined &&
    options !== null &&
    (typeof options !== "object" || Array.isArray(options))
  ) {
    return `Assistant ${assistantName}: input field options must be an object or null`
  }
  return undefined
}

function validateImportedInputFields(
  assistantName: string,
  fields: unknown
): string | undefined {
  if (!Array.isArray(fields)) {
    return `Invalid assistant ${assistantName}: missing input_fields array`
  }
  if (fields.length > IMPORT_MAX_INPUT_FIELDS_PER_ASSISTANT) {
    return `Assistant ${assistantName}: too many input fields (max ${IMPORT_MAX_INPUT_FIELDS_PER_ASSISTANT})`
  }
  for (const field of fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      return `Assistant ${assistantName}: invalid input field`
    }
    const fieldData = field as Record<string, unknown>
    if (
      typeof fieldData.name !== "string" ||
      typeof fieldData.label !== "string" ||
      typeof fieldData.field_type !== "string" ||
      !Number.isInteger(fieldData.position)
    ) {
      return `Assistant ${assistantName}: input field is missing required fields`
    }
    if (!IMPORTED_FIELD_TYPES.has(fieldData.field_type)) {
      return `Assistant ${assistantName}: unsupported input field type: ${fieldData.field_type}`
    }
    const optionsError = validateImportedInputFieldOptions(
      assistantName,
      fieldData.options
    )
    if (optionsError) return optionsError
  }
  return undefined
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined ||
    (Array.isArray(value) && value.every(item => typeof item === "string"))
}

function validateAssistantModelRoutingFamily(
  assistantName: string,
  assistant: Record<string, unknown>
): string | undefined {
  const family = assistant.model_routing_family
  if (
    family !== undefined &&
    family !== null &&
    (typeof family !== "string" || !MODEL_ROUTING_FAMILIES.has(family))
  ) {
    return `Assistant ${assistantName}: unsupported model_routing_family`
  }
  if (
    assistant.model_routing_mode === "advanced" &&
    (family === undefined || family === null)
  ) {
    return `Assistant ${assistantName}: advanced model routing requires model_routing_family`
  }
  if (
    family !== undefined &&
    family !== null &&
    assistant.model_routing_mode !== "advanced"
  ) {
    return `Assistant ${assistantName}: model_routing_family requires advanced model routing`
  }
  return undefined
}

function validateAssistantRoutingConfiguration(
  assistantName: string,
  assistant: Record<string, unknown>
): string | undefined {
  if (
    assistant.mode !== undefined &&
    (typeof assistant.mode !== "string" || !ASSISTANT_MODES.has(assistant.mode))
  ) {
    return `Assistant ${assistantName}: unsupported mode`
  }
  if (
    assistant.model_routing_mode !== undefined &&
    (typeof assistant.model_routing_mode !== "string" ||
      !MODEL_ROUTING_MODES.has(assistant.model_routing_mode))
  ) {
    return `Assistant ${assistantName}: unsupported model_routing_mode`
  }
  return validateAssistantModelRoutingFamily(assistantName, assistant)
}

function validateAssistantAgentConfiguration(
  assistantName: string,
  assistant: Record<string, unknown>
): string | undefined {
  if (!isOptionalStringArray(assistant.agent_enabled_tools)) {
    return `Assistant ${assistantName}: agent_enabled_tools must contain strings`
  }
  if (!isOptionalStringArray(assistant.agent_enabled_connectors)) {
    return `Assistant ${assistantName}: agent_enabled_connectors must contain strings`
  }
  if (!isOptionalInteger(assistant.agent_max_steps, 1, 50)) {
    return `Assistant ${assistantName}: agent_max_steps must be between 1 and 50`
  }
  if (!isOptionalInteger(assistant.agent_timeout_seconds, 1, 900)) {
    return `Assistant ${assistantName}: agent_timeout_seconds must be between 1 and 900`
  }
  if (!isOptionalNullableInteger(assistant.agent_cost_cap_cents, 1)) {
    return `Assistant ${assistantName}: agent_cost_cap_cents must be a positive integer`
  }
  if (!isOptionalNullableInteger(assistant.agent_max_requests_per_hour, 1)) {
    return `Assistant ${assistantName}: agent_max_requests_per_hour must be a positive integer`
  }
  return undefined
}

function validateAssistantPortableConfiguration(
  assistantName: string,
  assistant: Record<string, unknown>
): string | undefined {
  if (
    assistant.description !== undefined &&
    typeof assistant.description !== "string"
  ) {
    return `Assistant ${assistantName}: description must be a string`
  }
  if (
    assistant.status !== undefined &&
    typeof assistant.status !== "string"
  ) {
    return `Assistant ${assistantName}: status must be a string`
  }
  if (
    assistant.image_path !== undefined &&
    assistant.image_path !== null &&
    typeof assistant.image_path !== "string"
  ) {
    return `Assistant ${assistantName}: image_path must be a string or null`
  }
  if (
    assistant.is_parallel !== undefined &&
    typeof assistant.is_parallel !== "boolean"
  ) {
    return `Assistant ${assistantName}: is_parallel must be a boolean`
  }
  if (!isOptionalNullableInteger(assistant.timeout_seconds, 1)) {
    return `Assistant ${assistantName}: timeout_seconds must be a positive integer or null`
  }
  return undefined
}

function validateAssistantRetrievalScope(
  assistantName: string,
  retrievalScope: unknown
): string | undefined {
  if (retrievalScope === undefined || retrievalScope === null) return undefined
  if (typeof retrievalScope !== "object" || Array.isArray(retrievalScope)) {
    return `Assistant ${assistantName}: retrieval_scope must be an object`
  }
  const scope = retrievalScope as Record<string, unknown>
  if (
    scope.collectionId !== undefined &&
    scope.collectionId !== null &&
    typeof scope.collectionId !== "string"
  ) {
    return `Assistant ${assistantName}: retrieval_scope.collectionId must be a string`
  }
  if (
    scope.tags !== undefined &&
    (!Array.isArray(scope.tags) ||
      !scope.tags.every(tag => typeof tag === "string"))
  ) {
    return `Assistant ${assistantName}: retrieval_scope.tags must contain strings`
  }
  if (
    scope.maxVisibilityLevel !== undefined &&
    (typeof scope.maxVisibilityLevel !== "string" ||
      !RETRIEVAL_VISIBILITY_LEVELS.has(scope.maxVisibilityLevel))
  ) {
    return `Assistant ${assistantName}: unsupported retrieval visibility level`
  }
  return undefined
}

function validateImportedAssistantConfiguration(
  assistantName: string,
  assistant: Record<string, unknown>
): string | undefined {
  return (
    validateAssistantPortableConfiguration(assistantName, assistant) ??
    validateAssistantRoutingConfiguration(assistantName, assistant) ??
    validateAssistantAgentConfiguration(assistantName, assistant) ??
    validateAssistantRetrievalScope(assistantName, assistant.retrieval_scope)
  )
}

function validateImportedAssistant(assistant: unknown): string | undefined {
  if (!assistant || typeof assistant !== "object" || Array.isArray(assistant)) {
    return "Invalid assistant"
  }
  const assistantData = assistant as Record<string, unknown>
  if (!assistantData.name || typeof assistantData.name !== "string") {
    return "Invalid assistant: missing name"
  }
  if (assistantData.name.length > IMPORT_MAX_ASSISTANT_NAME_LENGTH) {
    return `Assistant name too long (max ${IMPORT_MAX_ASSISTANT_NAME_LENGTH} characters)`
  }
  return (
    validateImportedAssistantConfiguration(assistantData.name, assistantData) ??
    validateImportedPrompts(assistantData.name, assistantData.prompts) ??
    validateImportedInputFields(
      assistantData.name,
      assistantData.input_fields
    )
  )
}

/**
 * Validates import file structure, version, and per-field size limits.
 * Size limits mirror the runtime guards in assistant-execution-service.ts so
 * content that would be rejected at execution time is also rejected at import.
 */
export function validateImportFile(data: unknown): { valid: boolean; error?: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: "Invalid file format" }
  }

  const importData = data as Record<string, unknown>

  if (!importData.version) {
    return { valid: false, error: "Missing version information" }
  }

  // For now, we only support version 1.0
  if (importData.version !== CURRENT_EXPORT_VERSION) {
    return { valid: false, error: `Unsupported version: ${importData.version}. Expected: ${CURRENT_EXPORT_VERSION}` }
  }

  if (!Array.isArray(importData.assistants)) {
    return { valid: false, error: "Missing or invalid assistants array" }
  }

  const collectionLimitError = validateImportCollectionLimits(
    importData.assistants
  )
  if (collectionLimitError) {
    return { valid: false, error: collectionLimitError }
  }

  for (const assistant of importData.assistants) {
    const assistantError = validateImportedAssistant(assistant)
    if (assistantError) return { valid: false, error: assistantError }
  }

  const sizeError = validateSerializedImportSize(data)
  if (sizeError) return { valid: false, error: sizeError }

  return { valid: true }
}

/**
 * Maps model names to available model IDs
 */
export async function mapModelsForImport(modelNames: string[]): Promise<Map<string, number>> {
  const modelMap = new Map<string, number>()

  // Get all available models
  const models = await executeQuery(
    (db) => db.select({
      id: aiModels.id,
      modelId: aiModels.modelId,
      provider: aiModels.provider,
      capabilities: aiModels.capabilities
    })
    .from(aiModels)
    .where(eq(aiModels.active, true)),
    "getActiveModelsForImport"
  )

  // Create a lookup map
  const modelLookup = new Map(models.map(m => [m.modelId, m.id]))
  const providerDefaults = new Map<string, number>()

  // Set provider defaults
  for (const model of models) {
    if (!providerDefaults.has(model.provider)) {
      providerDefaults.set(model.provider, model.id)
    }
  }

  // Map each model name
  for (const modelName of modelNames) {
    // Try exact match first
    if (modelLookup.has(modelName)) {
      modelMap.set(modelName, modelLookup.get(modelName)!)
      continue
    }

    // Try to extract provider from model name
    const lowerName = modelName.toLowerCase()
    let mappedId: number | undefined

    if (lowerName.includes('gpt') || lowerName.includes('openai')) {
      mappedId = providerDefaults.get('openai')
    } else if (lowerName.includes('claude')) {
      mappedId = providerDefaults.get('anthropic') || providerDefaults.get('amazon-bedrock')
    } else if (lowerName.includes('gemini')) {
      mappedId = providerDefaults.get('google')
    }

    // If still no match, use the first available model
    if (!mappedId && models.length > 0) {
      mappedId = models[0].id
    }

    if (mappedId) {
      modelMap.set(modelName, mappedId)
      logger.info(`Mapped model ${modelName} to model ID ${mappedId}`)
    } else {
      logger.warn(`Could not map model ${modelName}, no models available`)
    }
  }

  return modelMap
}
