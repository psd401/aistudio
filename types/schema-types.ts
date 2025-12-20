/**
 * Schema Types
 *
 * @deprecated This file is maintained for backwards compatibility only.
 * All new code should import from `@/lib/db/types` instead.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #530 - Type unification strategy
 */

// Re-export select types from db-types
export type {
  SelectUser,
  SelectDocument,
  SelectAssistantArchitect,
  SelectToolInputField,
  SelectChainPrompt,
  SelectToolExecution,
  SelectPromptResult,
  SelectJob,
  SelectNavigationItem,
  SelectTool,
  SelectAiModel,
  InsertAssistantArchitect,
  InsertToolInputField,
  InsertChainPrompt,
  InsertToolExecution,
  InsertPromptResult,
  InsertJob,
  InsertNavigationItem,
  InsertDocument,
  InsertDocumentChunk,
  SelectDocumentChunk,
  InsertUser,
  InsertIdea,
  SelectIdea,
  InsertIdeaNote,
  SelectIdeaNote,
  InsertIdeaVote,
  SelectIdeaVote,
  InsertAiModel,
} from "@/types/db-types";

export type Role = "student" | "staff" | "administrator";
