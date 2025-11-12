import { SelectToolInputField, SelectChainPrompt, SelectToolExecution, SelectPromptResult } from "@/types/db-types"

// Input field option type
export interface InputFieldOption {
  label: string
  value: string
}

// Extended types with relations
// Note: PromptChainToolWithRelations removed as SelectPromptChainTool doesn't exist in db-types

export interface ToolExecutionWithRelations extends SelectToolExecution {
  results?: SelectPromptResult[]
}

// Form types for creating/editing
export interface CreatePromptChainToolForm {
  name: string
  description?: string
  isParallel: boolean
  timeoutSeconds?: number
}

export interface CreateToolInputFieldForm {
  name: string
  fieldType: "short_text" | "long_text" | "select" | "multi_select"
  options?: InputFieldOption[]
  position: number
}

export interface CreateChainPromptForm {
  name: string
  content: string
  modelId: string
  position: number
  parallelGroup?: number
  inputMapping?: Record<string, string>
  timeoutSeconds?: number
}

// Execution types
export interface ToolExecutionInput {
  [key: string]: string | string[] // Support both single and multi-select values
}

export interface PromptExecutionResult {
  promptId: string
  status: "pending" | "running" | "completed" | "failed"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>
  output?: string
  error?: string
  startTime: Date
  endTime?: Date
  executionTimeMs?: number
}

export interface ToolExecutionStatus {
  id: string
  status: "pending" | "running" | "completed" | "failed"
  results: PromptExecutionResult[]
  error?: string
  startTime: Date
  endTime?: Date
}

// Admin types
export interface ToolApprovalRequest {
  id: string
  name: string
  description?: string
  userId: string
  createdAt: Date
  inputFields: SelectToolInputField[]
  prompts: SelectChainPrompt[]
}

export interface ToolRejectionRequest {
  id: string
  reason: string
}

export interface ChainPrompt {
  id: string
  toolId: string
  name: string
  content: string
  systemContext?: string
  modelId: string
  position: number
  parallelGroup?: number
  inputMapping?: Record<string, string>
  timeoutSeconds: number
  createdAt: Date
  updatedAt: Date
} 