import { executeSQL } from "@/lib/db/data-api-adapter"
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

  // Create parameter placeholders for the IN clause
  const placeholders = assistantIds.map((_, index) => `:id${index}`).join(', ')
  const parameters = assistantIds.map((id, index) => ({
    name: `id${index}`,
    value: { longValue: id }
  }))

  // Fetch assistants
  const assistantsQuery = `
    SELECT id, name, description, status, image_path, is_parallel, timeout_seconds
    FROM assistant_architects
    WHERE id IN (${placeholders})
  `
  const assistantsRaw = await executeSQL(assistantsQuery, parameters)
  const assistants = assistantsRaw as Array<{
    id: number
    name: string
    description: string
    status: string
    imagePath?: string
    isParallel?: boolean
    timeoutSeconds?: number
  }>

  // For each assistant, fetch related data
  const exportedAssistants = await Promise.all(assistants.map(async (assistant) => {
    // Fetch prompts with model information
    const promptsQuery = `
      SELECT 
        cp.name, 
        cp.content, 
        cp.system_context, 
        cp.position,
        cp.parallel_group,
        cp.input_mapping,
        cp.timeout_seconds,
        am.model_id as model_name
      FROM chain_prompts cp
      LEFT JOIN ai_models am ON cp.model_id = am.id
      WHERE cp.assistant_architect_id = :assistantId
      ORDER BY cp.position ASC
    `
    const promptsRaw = await executeSQL(promptsQuery, [
      { name: 'assistantId', value: { longValue: assistant.id } }
    ])
    const prompts = promptsRaw as unknown as Array<{
      name: string
      content: string
      systemContext?: string
      position: number
      parallelGroup?: number
      inputMapping?: Record<string, unknown>
      timeoutSeconds?: number
      modelName: string
    }>

    // Fetch input fields
    const fieldsQuery = `
      SELECT name, label, field_type, position, options
      FROM tool_input_fields
      WHERE assistant_architect_id = :assistantId
      ORDER BY position ASC
    `
    const inputFieldsRaw = await executeSQL(fieldsQuery, [
      { name: 'assistantId', value: { longValue: assistant.id } }
    ])
    const inputFields = inputFieldsRaw as unknown as Array<{
      name: string
      label: string
      fieldType: string
      position: number
      options?: Record<string, unknown>
    }>

    return {
      name: assistant.name,
      description: assistant.description,
      status: assistant.status,
      image_path: assistant.imagePath,
      is_parallel: assistant.isParallel,
      timeout_seconds: assistant.timeoutSeconds,
      prompts: prompts.map(p => ({
        name: p.name,
        content: p.content,
        system_context: p.systemContext,
        model_name: p.modelName || 'gpt-4', // Default fallback
        position: p.position,
        parallel_group: p.parallelGroup,
        input_mapping: p.inputMapping,
        timeout_seconds: p.timeoutSeconds
      })),
      input_fields: inputFields.map(f => ({
        name: f.name,
        label: f.label,
        field_type: f.fieldType,
        position: f.position,
        options: f.options
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

/**
 * Validates import file structure and version
 */
export function validateImportFile(data: unknown): { valid: boolean; error?: string } {
  if (!data || typeof data !== 'object' || data === null) {
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

  // Validate each assistant structure
  for (const assistant of importData.assistants as Record<string, unknown>[]) {
    if (!assistant.name || typeof assistant.name !== 'string') {
      return { valid: false, error: "Invalid assistant: missing name" }
    }

    if (!Array.isArray(assistant.prompts)) {
      return { valid: false, error: `Invalid assistant ${assistant.name}: missing prompts array` }
    }

    if (!Array.isArray(assistant.input_fields)) {
      return { valid: false, error: `Invalid assistant ${assistant.name}: missing input_fields array` }
    }
  }

  return { valid: true }
}

/**
 * Maps model names to available model IDs
 */
export async function mapModelsForImport(modelNames: string[]): Promise<Map<string, number>> {
  const modelMap = new Map<string, number>()
  
  // Get all available models
  const modelsRaw = await executeSQL(`
    SELECT id, model_id, provider, capabilities
    FROM ai_models
    WHERE active = true
  `)
  const models = modelsRaw as unknown as Array<{
    id: number
    modelId: string
    provider: string
    capabilities?: unknown
  }>

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
      mappedId = providerDefaults.get('azure') || providerDefaults.get('amazon-bedrock')
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