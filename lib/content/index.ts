/**
 * Atrium content service layer — public surface
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). The single source of truth for how
 * content is created, versioned, and read. Every surface (server actions, REST
 * v1, MCP, scheduled skills) imports from here; there is no UI-only write path.
 *
 * See docs/features/atrium-design-spec.md §11.
 */

export { contentService } from "./content-service";
export type { DeletedContentSummary } from "./content-service";
export { versionService } from "./version-service";
export {
  contentSourceService,
  contentSourceEtag,
  ifNoneMatchIncludes,
} from "./source-read";
export { visibilityService } from "./visibility-service";
export { collectionService } from "./collection-service";
export type { CollectionTreeNode } from "./collection-service";
export {
  cleanupExpiredContentAssets,
  contentAssetService,
} from "./asset-service";
export type {
  ContentAssetDTO,
  InitiateContentAssetInput,
  InitiatedContentAsset,
} from "./asset-service";
export {
  contentAssetBytesPath,
  parseContentAssetDirectiveAttrs,
  parseContentAssetIds,
  serializeContentAssetDirective,
} from "./asset-directive";
export { navItemService } from "./nav-item-service";
export type { NavObject } from "./nav-item-service";
export { publishService } from "./publish-service";
export { retrievalService } from "./retrieval-service";
export type { RetrievalScope, RetrievalHit } from "./retrieval-service";
export { okfExportService } from "./okf/export";
export type { OkfExportInput, OkfExportResult } from "./okf/export";
export { okfImportService } from "./okf/import";
export type {
  OkfImportInput,
  OkfImportResult,
  OkfImportedObject,
} from "./okf/import";
export type {
  OkfBundle,
  OkfFile,
  OkfFrontmatter,
  OkfConcept,
  OkfAudience,
} from "./okf/profile";
export { OKF_VERSION, OKF_GENERATOR } from "./okf/profile";
export { s3Store } from "./storage/s3-store";
export { renderMarkdownToHtml } from "./render/markdown-render";
export { sanitizeHtml } from "./render/html-sanitize";

export { contentEvents } from "./events";
export type { ContentEventType, ContentEventPayload } from "./events";
export { recordContentAudit } from "./audit";
export type {
  ContentAuditAction,
  ContentAuditSurface,
  ContentAuditOutcome,
  ContentAuditEntry,
} from "./audit";

export {
  requesterFromApiAuth,
  buildDelegatedRequester,
} from "./requester-from-auth";
export type { RequesterAuthInput } from "./requester-from-auth";

export {
  ContentError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  ConflictError,
  VersionPreconditionFailedError,
  StorageError,
  ApprovalRequiredError,
  isContentError,
} from "./errors";

export {
  cleanupExpiredContentIdempotencyRecords,
  contentHeadEtag,
  hashIdempotencyRequest,
  parseContentIfMatch,
  runIdempotentMutation,
  validateIdempotencyKey,
} from "./idempotency";

export {
  assertCanCreate,
  assertCanDelete,
  assertCanEdit,
  canDelete,
  canEdit,
  canPublishPublic,
  hasPublishPublicScope,
  principalOf,
  slugifyTitle,
} from "./helpers";

export type {
  Requester,
  Principal,
  CreateObjectInput,
  UpdatePatch,
  ListFilter,
  VisibilityInput,
  VisibilityGrant,
  GrantKind,
  VisibilityLevel,
  ContentKind,
  BodyFormat,
  SnapshotInput,
  ContentObjectDTO,
  ContentVersionDTO,
  ContentObjectWithVersion,
  ContentSourceDTO,
} from "./types";
