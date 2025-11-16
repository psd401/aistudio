import {
  SelectAssistantArchitect,
  SelectToolInputField,
  SelectChainPrompt,
  SelectToolExecution,
  SelectPromptResult
} from "@/types/db-types"

// Input field option type
export interface InputFieldOption {
  label: string
  value: string
}

// Interface combining the main tool data with its relations
export interface AssistantArchitectWithRelations extends SelectAssistantArchitect {
  inputFields: SelectToolInputField[]
  prompts: SelectChainPrompt[]
  executions?: SelectToolExecution[] // Optional depending on context
}

// Interface for the form used to create a new tool
export interface CreateAssistantArchitectForm {
  name: string
  description?: string
  // Add other fields needed for creation form if different from InsertAssistantArchitect
}

// Interface for execution results
export interface ExecutionResultDetails extends SelectToolExecution {
  promptResults: (SelectPromptResult & { userFeedback?: 'like' | 'dislike' })[]
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
  fieldType: "short_text" | "long_text" | "select" | "multi_select" | "file_upload"
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
  repositoryIds?: number[]
  enabledTools?: string[]
}

// Execution types
export interface ToolExecutionInput {
  [key: string]: string | string[] // Support both single and multi-select values
}

export interface PromptExecutionResult {
  promptId: string
  status: "pending" | "running" | "completed" | "failed"
  input: Record<string, unknown>
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
  repositoryIds?: number[]
  enabledTools?: string[]
  createdAt: Date
  updatedAt: Date
}

// Job system types
/**
 * Result of a single prompt execution within a job
 */
export interface JobPromptResult {
  promptId: string | number
  status: string
  input: Record<string, unknown>
  output?: string
  error?: string
  startTime: string
  endTime?: string
  executionTimeMs?: number
  userFeedback?: 'like' | 'dislike'
}

/**
 * Complete output format for a job execution
 */
export interface JobOutput {
  executionId: string
  results: JobPromptResult[]
}

// Note: SelectToolInputField includes a 'label' property for user-facing display, in addition to 'name' for internal use. 