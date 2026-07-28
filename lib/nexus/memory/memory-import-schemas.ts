import { z } from "zod"
import { NEXUS_MEMORY_CATEGORIES } from "@/lib/db/schema"
import {
  MAX_MEMORY_IMPORT_CANDIDATES,
  MAX_MEMORY_IMPORT_CHARS,
  MAX_NEXUS_MEMORY_CONTENT_CHARS,
} from "./memory-constants"

export const MEMORY_IMPORT_VENDORS = [
  "chatgpt",
  "claude",
  "gemini",
] as const

export const MemoryImportVendorSchema = z.enum(MEMORY_IMPORT_VENDORS)

export const MemoryImportCandidateSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Memory content is required")
    .max(
      MAX_NEXUS_MEMORY_CONTENT_CHARS,
      `Memory content cannot exceed ${MAX_NEXUS_MEMORY_CONTENT_CHARS} characters`,
    ),
  category: z.enum(NEXUS_MEMORY_CATEGORIES),
})

export const MemoryImportCandidateBatchSchema = z.object({
  candidates: z
    .array(MemoryImportCandidateSchema)
    .max(
      MAX_MEMORY_IMPORT_CANDIDATES,
      `An import can contain at most ${MAX_MEMORY_IMPORT_CANDIDATES} memories`,
    ),
})

export const ExtractMemoryImportCandidatesSchema = z.object({
  vendor: MemoryImportVendorSchema,
  pastedText: z
    .string()
    .trim()
    .min(1, "Paste the memory list you received")
    .max(
      MAX_MEMORY_IMPORT_CHARS,
      `Pasted text cannot exceed ${MAX_MEMORY_IMPORT_CHARS.toLocaleString()} characters`,
    ),
})

export const SaveImportedMemoriesSchema = z.object({
  vendor: MemoryImportVendorSchema,
  candidates: z
    .array(MemoryImportCandidateSchema)
    .min(1, "Select at least one memory to import")
    .max(
      MAX_MEMORY_IMPORT_CANDIDATES,
      `You can import at most ${MAX_MEMORY_IMPORT_CANDIDATES} memories at once`,
    ),
})

export type MemoryImportVendor = z.infer<typeof MemoryImportVendorSchema>
export type MemoryImportCandidate = z.infer<
  typeof MemoryImportCandidateSchema
>
export type ExtractMemoryImportCandidatesInput = z.infer<
  typeof ExtractMemoryImportCandidatesSchema
>
export type SaveImportedMemoriesInput = z.infer<
  typeof SaveImportedMemoriesSchema
>
