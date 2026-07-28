import { z } from "zod"
import { NEXUS_MEMORY_CATEGORIES } from "@/lib/db/schema"
import {
  MAX_BULK_MEMORY_DELETE_COUNT,
  MAX_NEXUS_MEMORY_CONTENT_CHARS,
} from "./memory-constants"

const memoryId = z.string().uuid("Memory id must be a valid UUID")
const memoryContent = z
  .string()
  .trim()
  .min(1, "Memory content is required")
  .max(
    MAX_NEXUS_MEMORY_CONTENT_CHARS,
    `Memory content cannot exceed ${MAX_NEXUS_MEMORY_CONTENT_CHARS} characters`,
  )

export const AddNexusMemorySchema = z.object({
  content: memoryContent,
  category: z.enum(NEXUS_MEMORY_CATEGORIES),
})

export const UpdateNexusMemorySchema = AddNexusMemorySchema.extend({
  memoryId,
})

export const DeleteNexusMemorySchema = z.object({
  memoryId,
})

export const BulkDeleteNexusMemoriesSchema = z.object({
  memoryIds: z
    .array(memoryId)
    .min(1, "Select at least one memory")
    .max(
      MAX_BULK_MEMORY_DELETE_COUNT,
      `You can delete up to ${MAX_BULK_MEMORY_DELETE_COUNT} memories at once`,
    )
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Memory ids must be unique",
    ),
})

export const SetNexusMemoryEnabledSchema = z.object({
  enabled: z.boolean(),
})

export type AddNexusMemoryInput = z.infer<typeof AddNexusMemorySchema>
export type UpdateNexusMemoryInput = z.infer<
  typeof UpdateNexusMemorySchema
>
