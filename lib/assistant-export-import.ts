import { executeQuery } from "@/lib/db/drizzle-client"
import { inArray, eq } from "drizzle-orm"
import { assistantArchitects, chainPrompts, toolInputFields, aiModels } from "@/lib/db/schema"
import logger from "@/lib/logger"
export interface ExportedAssistant {
  name: string
  description: string
  status: string
  image_path?: string
  is_parallel?: boolean
  timeout_seconds?: number
  prompts: Array<{
    name: string
    content: string
    system_context?: string
    model_name: string // Using model name instead of ID for portability
    position: number
    parallel_group?: number
    input_mapping?: Record<string, unknown>
    timeout_seconds?: number
  }>
  input_fields: Array<{
    name: string
    label: string
    field_type: string
    position: number
    options?: Record<string, unknown>
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
export async function getAssistantDataForExport(assistantIds: number[]): Promise<ExportedAssistant[]> {
  if (assistantIds.length === 0) return []

  // Fetch assistants
  const assistants = await executeQuery(
    (db) => db.select({
      id: assistantArchitects.id,
      name: assistantArchitects.name,
      description: assistantArchitects.description,
      status: assistantArchitects.status,
      imagePath: assistantArchitects.imagePath,
      isParallel: assistantArchitects.isParallel,
      timeoutSeconds: assistantArchitects.timeoutSeconds
    })
    .from(assistantArchitects)
    .where(inArray(assistantArchitects.id, assistantIds)),
    "getAssistantsForExport"
  )

  // For each assistant, fetch related data
  const exportedAssistants = await Promise.all(assistants.map(async (assistant) => {
    // Fetch prompts with model information
    const prompts = await executeQuery(
      (db) => db.select({
        name: chainPrompts.name,
        content: chainPrompts.content,
        systemContext: chainPrompts.systemContext,
        position: chainPrompts.position,
        parallelGroup: chainPrompts.parallelGroup,
        inputMapping: chainPrompts.inputMapping,
        timeoutSeconds: chainPrompts.timeoutSeconds,
        modelName: aiModels.modelId
      })
      .from(chainPrompts)
      .leftJoin(aiModels, eq(chainPrompts.modelId, aiModels.id))
      .where(eq(chainPrompts.assistantArchitectId, assistant.id))
      .orderBy(chainPrompts.position),
      "getPromptsForExport"
    )

    // Fetch input fields
    const inputFields = await executeQuery(
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
      prompts: prompts.map(p => ({
        name: p.name,
        content: p.content,
        system_context: p.systemContext ?? undefined,
        model_name: p.modelName || 'gpt-4', // Default fallback
        position: p.position,
        parallel_group: p.parallelGroup ?? undefined,
        input_mapping: p.inputMapping ?? undefined,
        timeout_seconds: p.timeoutSeconds ?? undefined
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
export const ASSISTANT_IMPORT_MAX_BYTES = 10 * 1024 * 1024

export function assistantImportContentLengthExceedsLimit(
  contentLength: string | null
): boolean {
  if (!contentLength) return false
  const parsed = Number(contentLength)
  return Number.isFinite(parsed) && parsed > ASSISTANT_IMPORT_MAX_BYTES
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

function validateImportedInputFields(
  assistantName: string,
  fields: unknown
): string | undefined {
  if (!Array.isArray(fields)) {
    return `Invalid assistant ${assistantName}: missing input_fields array`
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
  }
  return undefined
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
