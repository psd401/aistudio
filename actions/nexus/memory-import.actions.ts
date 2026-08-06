"use server"

import { revalidatePath } from "next/cache"
import type { z } from "zod"
import type { ActionState } from "@/types"
import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
  startTimer,
} from "@/lib/logger"
import {
  createSuccess,
  ErrorFactories,
  handleError,
} from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle"
import type { NexusMemorySource } from "@/lib/db/schema"
import {
  isNexusMemoryEnabledForUser,
  isNexusMemoryGloballyEnabled,
} from "@/lib/nexus/memory/memory-availability"
import { extractMemoryImportCandidates } from "@/lib/nexus/memory/memory-import"
import {
  ExtractMemoryImportCandidatesSchema,
  SaveImportedMemoriesSchema,
  type ExtractMemoryImportCandidatesInput,
  type MemoryImportCandidate,
  type SaveImportedMemoriesInput,
} from "@/lib/nexus/memory/memory-import-schemas"
import { memoryService } from "@/lib/nexus/memory/memory-service"
import { ContentSafetyBlockedError } from "@/lib/streaming/types"
import { hasCapabilityAccess } from "@/utils/roles"

const GENERIC_CANDIDATE_FAILURE_REASON =
  "This memory could not be saved. Try again in a moment."

interface MemoryImportRequester {
  userId: number
  cognitoSub: string
}

export interface ExtractedMemoryImportData {
  candidates: MemoryImportCandidate[]
}

export interface ImportedMemoryItemResult {
  index: number
  status: "saved" | "failed"
  memoryId?: string
  action?: "inserted" | "updated"
  /** Present on failures only. Safe to render to the user. */
  reason?: string
}

/**
 * A user-safe explanation for one rejected candidate. Blocked-content messages
 * are already written for users; every other failure stays generic so provider,
 * database, and embedding internals never reach the browser.
 *
 * Without this the dialog showed only "N need attention", and a prod user
 * retried the same deterministically rejected batch eight times in an hour.
 */
function candidateFailureReason(error: unknown): string {
  if (error instanceof ContentSafetyBlockedError) {
    return error.blockedMessage
  }
  return GENERIC_CANDIDATE_FAILURE_REASON
}

export interface SaveImportedMemoriesResult {
  total: number
  successful: number
  failed: number
  results: ImportedMemoryItemResult[]
}

function validationFields(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }))
}

function memoryImportValidationError(error: z.ZodError) {
  const fields = validationFields(error)
  return ErrorFactories.validationFailed(fields, {
    userMessage: fields[0]?.message ?? "Check the memory import input",
  })
}

async function requireMemoryImportRequester(): Promise<MemoryImportRequester> {
  const session = await getServerSession()
  if (!session) {
    throw ErrorFactories.authNoSession()
  }
  if (!(await hasCapabilityAccess("nexus-memory", session.sub))) {
    throw ErrorFactories.authzInsufficientPermissions(undefined, undefined, {
      requiredPermission: "nexus-memory",
    })
  }
  const userId = await getUserIdByCognitoSubAsNumber(session.sub)
  if (!userId) {
    throw ErrorFactories.dbRecordNotFound("users", session.sub)
  }
  return { userId, cognitoSub: session.sub }
}

async function requireMemoryImportEnabled(userId: number): Promise<void> {
  if (!(await isNexusMemoryGloballyEnabled())) {
    throw ErrorFactories.bizInvalidState(
      "import Nexus memories",
      "disabled",
      "enabled",
      { userMessage: "Nexus memory is currently disabled" },
    )
  }
  if (!(await isNexusMemoryEnabledForUser(userId))) {
    throw ErrorFactories.bizInvalidState(
      "import Nexus memories",
      "disabled for this account",
      "enabled for this account",
      {
        userMessage:
          "Enable memory for your account before importing memories",
      },
    )
  }
}

export async function extractImportCandidates(
  input: ExtractMemoryImportCandidatesInput,
): Promise<ActionState<ExtractedMemoryImportData>> {
  const requestId = generateRequestId()
  const timer = startTimer("extractImportCandidates")
  const log = createLogger({
    requestId,
    action: "extractImportCandidates",
  })

  try {
    const requester = await requireMemoryImportRequester()
    await requireMemoryImportEnabled(requester.userId)
    const parsed = ExtractMemoryImportCandidatesSchema.safeParse(input)
    if (!parsed.success) {
      throw memoryImportValidationError(parsed.error)
    }

    const candidates = await extractMemoryImportCandidates(parsed.data)
    timer({ status: "success" })
    log.info("Nexus memory import candidates extracted", {
      userId: requester.userId,
      vendor: parsed.data.vendor,
      candidateCount: candidates.length,
    })
    return createSuccess(
      { candidates },
      candidates.length === 0
        ? "No durable memories were found"
        : `${candidates.length} memory candidates ready to review`,
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(
      error,
      "Failed to extract memories. Your pasted text was not changed.",
      {
        context: "extractImportCandidates",
        requestId,
        operation: "extractImportCandidates",
      },
    )
  }
}

export async function saveImportedMemories(
  input: SaveImportedMemoriesInput,
): Promise<ActionState<SaveImportedMemoriesResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("saveImportedMemories")
  const log = createLogger({
    requestId,
    action: "saveImportedMemories",
  })

  try {
    const requester = await requireMemoryImportRequester()
    await requireMemoryImportEnabled(requester.userId)
    const parsed = SaveImportedMemoriesSchema.safeParse(input)
    if (!parsed.success) {
      throw memoryImportValidationError(parsed.error)
    }

    const source: NexusMemorySource = `import:${parsed.data.vendor}`
    const results: ImportedMemoryItemResult[] = []
    for (const [index, candidate] of parsed.data.candidates.entries()) {
      try {
        // This shared service is the non-negotiable sanitize -> embed -> dedup
        // choke point. Import actions never write memory rows directly.
        const saved = await memoryService.save({
          userId: requester.userId,
          sessionId: requester.cognitoSub,
          content: candidate.content,
          category: candidate.category,
          source,
        })
        results.push({
          index,
          status: "saved",
          memoryId: saved.memory.id,
          action: saved.action,
        })
      } catch (error) {
        log.warn("One Nexus memory import candidate failed", {
          userId: requester.userId,
          vendor: parsed.data.vendor,
          candidateIndex: index,
          error: sanitizeForLogging(
            error instanceof Error ? error.message : String(error),
          ),
        })
        results.push({
          index,
          status: "failed",
          reason: candidateFailureReason(error),
        })
      }
    }

    const successful = results.filter(
      (result) => result.status === "saved",
    ).length
    const data = {
      total: results.length,
      successful,
      failed: results.length - successful,
      results,
    }
    if (successful > 0) {
      revalidatePath("/settings")
    }
    timer({ status: "success" })
    log.info("Nexus memory import completed", {
      userId: requester.userId,
      vendor: parsed.data.vendor,
      total: data.total,
      successful: data.successful,
      failed: data.failed,
    })
    return createSuccess(
      data,
      data.failed === 0
        ? `${data.successful} memories imported`
        : `${data.successful} of ${data.total} memories imported`,
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to import memories", {
      context: "saveImportedMemories",
      requestId,
      operation: "saveImportedMemories",
    })
  }
}
