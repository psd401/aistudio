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
export { versionService } from "./version-service";
export { visibilityService } from "./visibility-service";
export { s3Store } from "./storage/s3-store";
export { renderMarkdownToHtml, sanitizeHtml } from "./render/markdown-render";

export {
  ContentError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  ConflictError,
  ApprovalRequiredError,
  isContentError,
} from "./errors";

export {
  assertCanCreate,
  assertCanEdit,
  canEdit,
  canPublishPublic,
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
} from "./types";
