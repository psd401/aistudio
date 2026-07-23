"use server"

import { and, desc, eq, inArray } from "drizzle-orm"
import { getServerSession } from "@/lib/auth/server-session"
import { executeQuery } from "@/lib/db/drizzle-client"
import {
  knowledgeRepositories,
  repositoryArtifacts,
  repositoryItemChunks,
  repositoryItemVersions,
  repositoryProcessingJobs,
  type RepositoryArtifactKind,
  type RepositoryInspectionStatus,
  type RepositorySourceKind,
  type RepositorySourceLocator,
  type RepositoryStorageStatus,
  type RepositoryVersionProcessingStatus,
} from "@/lib/db/schema"
import {
  getRepositoryItemById,
} from "@/lib/db/drizzle"
import {
  assertItemRepositoryReadAccess,
} from "@/lib/repositories/repository-access-guard"
import {
  canModifyRepository,
  getUserIdFromSession,
} from "@/actions/repositories/repository-permissions"
import { hasCapabilityAccess } from "@/utils/roles"
import {
  createSuccess,
  ErrorFactories,
  handleError,
} from "@/lib/error-utils"
import type { ActionState } from "@/types/actions-types"
import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger"

export interface RepositoryVersionManagementView {
  id: string
  versionNumber: number
  sourceKind: RepositorySourceKind
  sourceRevision: string | null
  originalFileName: string | null
  declaredContentType: string | null
  detectedContentType: string | null
  byteSize: number | null
  sha256: string | null
  storageStatus: RepositoryStorageStatus
  inspectionStatus: RepositoryInspectionStatus
  processingStatus: RepositoryVersionProcessingStatus
  processorVersion: string | null
  createdAt: Date
  isCurrent: boolean
}

export interface RepositoryProcessingJobManagementView {
  id: string
  itemVersionId: string
  stage: string
  status: string
  attempt: number
  maxAttempts: number
  lastErrorCode: string | null
  lastErrorMessage: string | null
  startedAt: Date | null
  finishedAt: Date | null
  updatedAt: Date
}

export interface RepositoryArtifactManagementView {
  id: string
  itemVersionId: string
  kind: RepositoryArtifactKind
  mediaType: string
  pageFrom: number | null
  pageTo: number | null
  timeStartMs: number | null
  timeEndMs: number | null
  processorName: string
  processorVersion: string
  createdAt: Date
}

export interface RepositoryCitationManagementView {
  chunkId: number
  itemVersionId: string
  artifactId: string | null
  chunkIndex: number
  modality: "text" | "image" | "audio" | "video" | "table"
  sourceLocator: RepositorySourceLocator
}

export interface RepositoryItemManagementView {
  itemId: number
  repositoryId: number
  itemName: string
  itemType: string
  sourceSummary: string
  currentVersionId: string | null
  canManage: boolean
  versions: RepositoryVersionManagementView[]
  jobs: RepositoryProcessingJobManagementView[]
  artifacts: RepositoryArtifactManagementView[]
  citations: RepositoryCitationManagementView[]
}

function originalFileName(metadata: Record<string, unknown>): string | null {
  const value = metadata.originalFileName
  return typeof value === "string" && value.trim() ? value : null
}

function sourceSummary(
  item: NonNullable<Awaited<ReturnType<typeof getRepositoryItemById>>>,
  currentVersion: RepositoryVersionManagementView | undefined
): string {
  if (item.type === "url") return item.source
  if (item.type === "text") return "Inline text"
  return (
    currentVersion?.originalFileName ??
    (typeof item.metadata?.originalFileName === "string"
      ? item.metadata.originalFileName
      : item.name)
  )
}

export async function getRepositoryItemManagementView(
  itemId: number
): Promise<ActionState<RepositoryItemManagementView>> {
  const requestId = generateRequestId()
  const timer = startTimer("getRepositoryItemManagementView")
  const log = createLogger({
    requestId,
    action: "getRepositoryItemManagementView",
  })

  try {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw ErrorFactories.invalidInput("itemId", itemId, "A positive item id is required")
    }

    const session = await getServerSession()
    if (!session) throw ErrorFactories.authNoSession()
    if (!(await hasCapabilityAccess("knowledge-repositories"))) {
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    await assertItemRepositoryReadAccess(itemId, session.sub)
    const item = await getRepositoryItemById(itemId)
    if (!item) {
      throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    }

    const userId = await getUserIdFromSession(session.sub)
    const canManage = await canModifyRepository(item.repositoryId, userId)

    const versionRows = await executeQuery(
      (db) =>
        db
          .select()
          .from(repositoryItemVersions)
          .where(eq(repositoryItemVersions.itemId, itemId))
          .orderBy(desc(repositoryItemVersions.versionNumber)),
      "getRepositoryItemManagementView.versions"
    )
    const versions: RepositoryVersionManagementView[] = versionRows.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      sourceKind: version.sourceKind,
      sourceRevision: version.sourceRevision,
      originalFileName: originalFileName(version.metadata),
      declaredContentType: version.declaredContentType,
      detectedContentType: version.detectedContentType,
      byteSize: version.byteSize,
      sha256: version.sha256,
      storageStatus: version.storageStatus,
      inspectionStatus: version.inspectionStatus,
      processingStatus: version.processingStatus,
      processorVersion: version.processorVersion,
      createdAt: version.createdAt,
      isCurrent: version.id === item.currentVersionId,
    }))
    const versionIds = versions.map((version) => version.id)

    const [jobRows, artifactRows, generationRows] = await Promise.all([
      versionIds.length > 0
        ? executeQuery(
            (db) =>
              db
                .select()
                .from(repositoryProcessingJobs)
                .where(inArray(repositoryProcessingJobs.itemVersionId, versionIds))
                .orderBy(desc(repositoryProcessingJobs.createdAt)),
            "getRepositoryItemManagementView.jobs"
          )
        : Promise.resolve([]),
      versionIds.length > 0
        ? executeQuery(
            (db) =>
              db
                .select()
                .from(repositoryArtifacts)
                .where(inArray(repositoryArtifacts.itemVersionId, versionIds))
                .orderBy(desc(repositoryArtifacts.createdAt)),
            "getRepositoryItemManagementView.artifacts"
          )
        : Promise.resolve([]),
      executeQuery(
        (db) =>
          db
            .select({
              activeIndexGenerationId:
                knowledgeRepositories.activeIndexGenerationId,
            })
            .from(knowledgeRepositories)
            .where(eq(knowledgeRepositories.id, item.repositoryId))
            .limit(1),
        "getRepositoryItemManagementView.generation"
      ),
    ])

    const activeIndexGenerationId =
      generationRows[0]?.activeIndexGenerationId ?? null
    const citationRows = activeIndexGenerationId && versionIds.length > 0
      ? await executeQuery(
          (db) =>
            db
              .select({
                chunkId: repositoryItemChunks.id,
                itemVersionId: repositoryItemChunks.itemVersionId,
                artifactId: repositoryItemChunks.artifactId,
                chunkIndex: repositoryItemChunks.chunkIndex,
                modality: repositoryItemChunks.modality,
                sourceLocator: repositoryItemChunks.sourceLocator,
              })
              .from(repositoryItemChunks)
              .where(
                and(
                  eq(
                    repositoryItemChunks.indexGenerationId,
                    activeIndexGenerationId
                  ),
                  inArray(repositoryItemChunks.itemVersionId, versionIds)
                )
              )
              .orderBy(repositoryItemChunks.chunkIndex)
              .limit(100),
          "getRepositoryItemManagementView.citations"
        )
      : []

    const currentVersion = versions.find((version) => version.isCurrent)
    const result: RepositoryItemManagementView = {
      itemId: item.id,
      repositoryId: item.repositoryId,
      itemName: item.name,
      itemType: item.type,
      sourceSummary: sourceSummary(item, currentVersion),
      currentVersionId: item.currentVersionId,
      canManage,
      versions,
      jobs: jobRows.map((job) => ({
        id: job.id,
        itemVersionId: job.itemVersionId,
        stage: job.stage,
        status: job.status,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        lastErrorCode: canManage ? job.lastErrorCode : null,
        lastErrorMessage: canManage ? job.lastErrorMessage : null,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        updatedAt: job.updatedAt,
      })),
      artifacts: artifactRows.map((artifact) => ({
        id: artifact.id,
        itemVersionId: artifact.itemVersionId,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        pageFrom: artifact.pageFrom,
        pageTo: artifact.pageTo,
        timeStartMs: artifact.timeStartMs,
        timeEndMs: artifact.timeEndMs,
        processorName: artifact.processorName,
        processorVersion: artifact.processorVersion,
        createdAt: artifact.createdAt,
      })),
      citations: citationRows.flatMap((citation) =>
        citation.itemVersionId
          ? [
              {
                chunkId: citation.chunkId,
                itemVersionId: citation.itemVersionId,
                artifactId: citation.artifactId,
                chunkIndex: citation.chunkIndex,
                modality: citation.modality,
                sourceLocator: citation.sourceLocator,
              },
            ]
          : []
      ),
    }

    timer({
      status: "success",
      versionCount: result.versions.length,
      citationCount: result.citations.length,
    })
    return createSuccess(result, "Repository item details loaded")
  } catch (error) {
    timer({ status: "error" })
    log.warn("Failed to load repository item details", { itemId })
    return handleError(error, "Failed to load repository item details", {
      context: "getRepositoryItemManagementView",
      requestId,
      operation: "getRepositoryItemManagementView",
      metadata: { itemId },
    })
  }
}
