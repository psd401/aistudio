import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  nexusConversations,
  nexusRepositoryBindings,
  repositoryItemVersions,
  repositoryItems,
  repositoryUploadSessions,
} from "@/lib/db/schema";
import {
  getContentPlatformConfig,
  type ContentPlatformConfig,
} from "@/lib/repositories/content-platform/config";

const UUID_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export type NexusRepositoryRetentionPolicy = Pick<
  ContentPlatformConfig,
  "nexusAttachmentRetentionDays" | "deletionGraceDays"
>;

export interface NexusRepositoryBindingResult {
  bindingId: string;
  ownerId: number;
  draftKey: string;
  conversationId: string | null;
  repositoryId: number;
  repositoryKind: "durable" | "ephemeral";
  lifecycleStatus: "active" | "expired" | "deleting" | "deleted";
  retentionDays: number | null;
  expiresAt: Date | null;
  created: boolean;
}

export interface GetOrCreateNexusRepositoryInput {
  ownerId: number;
  draftKey: string;
  now?: Date;
  policy?: NexusRepositoryRetentionPolicy;
}

export interface BindNexusRepositoryInput {
  ownerId: number;
  draftKey: string;
  conversationId: string;
  now?: Date;
}

export interface ResolveNexusRepositoriesInput {
  ownerId: number;
  conversationId: string;
  now?: Date;
}

export interface PromoteNexusRepositoryInput {
  ownerId: number;
  repositoryId: number;
  name: string;
  now?: Date;
  policy?: NexusRepositoryRetentionPolicy;
}

export interface ResolveNexusAttachmentReferenceInput {
  ownerId: number;
  bindingId: string;
  itemId: number;
  now?: Date;
}

export interface ResolveNexusAttachmentForPromotionInput
  extends ResolveNexusAttachmentReferenceInput {
  policy?: NexusRepositoryRetentionPolicy;
}

export interface ResolveNexusRepositoryBindingInput {
  ownerId: number;
  bindingId: string;
  now?: Date;
}

export interface NexusConversationOwnershipInput {
  ownerId: number;
  conversationId: string;
}

export interface DiscardNexusEphemeralRepositoryInput {
  ownerId: number;
  bindingId: string;
  repositoryId: number;
}

export interface NexusAttachmentReferenceResolution {
  bindingId: string;
  draftKey: string;
  conversationId: string | null;
  repositoryId: number;
  itemId: number;
  itemType: string;
  itemName: string;
  currentVersionId: string | null;
  processingStatus: string | null;
}

export interface NexusAttachmentReference {
  bindingId: string;
  itemId: number;
}

export interface NexusAttachmentImageSource {
  bindingId: string;
  repositoryId: number;
  itemId: number;
  itemVersionId: string;
  objectKey: string;
  declaredContentType: string | null;
  detectedContentType: string | null;
  byteSize: number | null;
}

export interface BindNexusAttachmentReferencesInput {
  ownerId: number;
  conversationId: string;
  references: NexusAttachmentReference[];
  now?: Date;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid UUID`);
  }
}

function assertRepositoryName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 500) {
    throw new Error("Repository name must contain between 1 and 500 characters");
  }
  return name;
}

async function resolvePolicy(
  policy: NexusRepositoryRetentionPolicy | undefined
): Promise<NexusRepositoryRetentionPolicy> {
  if (policy) return policy;
  const config = await getContentPlatformConfig();
  return {
    nexusAttachmentRetentionDays: config.nexusAttachmentRetentionDays,
    deletionGraceDays: config.deletionGraceDays,
  };
}

export function nexusRepositoryExpiresAt(
  now: Date,
  retentionDays: number
): Date {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3650
  ) {
    throw new Error("Nexus attachment retention must be between 1 and 3650 days");
  }
  return new Date(now.getTime() + retentionDays * DAY_MS);
}

export function nexusRepositoryGraceEndsAt(
  expiresAt: Date,
  deletionGraceDays: number
): Date {
  if (
    !Number.isSafeInteger(deletionGraceDays) ||
    deletionGraceDays < 1 ||
    deletionGraceDays > 365
  ) {
    throw new Error("Content deletion grace must be between 1 and 365 days");
  }
  return new Date(expiresAt.getTime() + deletionGraceDays * DAY_MS);
}

export function isNexusRepositoryPromotable(input: {
  repositoryKind: string;
  lifecycleStatus: string;
  expiresAt: Date | null;
  deletionGraceDays: number;
  now: Date;
}): boolean {
  if (
    !["active", "expired"].includes(input.lifecycleStatus) ||
    !["durable", "ephemeral"].includes(input.repositoryKind)
  ) {
    return false;
  }
  if (input.repositoryKind === "durable") {
    return (
      input.lifecycleStatus === "active" &&
      (input.expiresAt == null ||
        input.expiresAt.getTime() > input.now.getTime())
    );
  }
  return (
    input.expiresAt != null &&
    nexusRepositoryGraceEndsAt(
      input.expiresAt,
      input.deletionGraceDays
    ).getTime() > input.now.getTime()
  );
}

function resultFromRows(
  binding: typeof nexusRepositoryBindings.$inferSelect,
  repository: typeof knowledgeRepositories.$inferSelect,
  created: boolean
): NexusRepositoryBindingResult {
  if (
    repository.repositoryKind !== "durable" &&
    repository.repositoryKind !== "ephemeral"
  ) {
    throw new Error("Nexus repository binding is unavailable");
  }
  return {
    bindingId: binding.id,
    ownerId: binding.ownerId,
    draftKey: binding.draftKey,
    conversationId: binding.conversationId,
    repositoryId: repository.id,
    repositoryKind: repository.repositoryKind,
    lifecycleStatus: repository.lifecycleStatus,
    retentionDays: repository.retentionDays,
    expiresAt: repository.expiresAt,
    created,
  };
}

/**
 * Create one private repository for an owner-bound client draft. The advisory
 * lock prevents concurrent multi-file adds from creating duplicate containers.
 * Reusing an unpurged ephemeral draft refreshes its configured retention.
 */
export async function getOrCreateNexusEphemeralRepository(
  input: GetOrCreateNexusRepositoryInput
): Promise<NexusRepositoryBindingResult> {
  assertPositiveId(input.ownerId, "Owner id");
  assertUuid(input.draftKey, "Draft key");
  const now = input.now ?? new Date();
  const policy = await resolvePolicy(input.policy);
  const expiresAt = nexusRepositoryExpiresAt(
    now,
    policy.nexusAttachmentRetentionDays
  );

  return executeTransaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${`${input.ownerId}:${input.draftKey}`}, 0)
        )`
      );

      const [existing] = await tx
        .select({
          binding: nexusRepositoryBindings,
          repository: knowledgeRepositories,
        })
        .from(nexusRepositoryBindings)
        .innerJoin(
          knowledgeRepositories,
          eq(
            knowledgeRepositories.id,
            nexusRepositoryBindings.repositoryId
          )
        )
        .where(
          and(
            eq(nexusRepositoryBindings.ownerId, input.ownerId),
            eq(nexusRepositoryBindings.draftKey, input.draftKey)
          )
        )
        .limit(1)
        .for("update");

      if (existing) {
        if (
          existing.repository.repositoryKind === "system" ||
          existing.repository.lifecycleStatus === "deleting" ||
          existing.repository.lifecycleStatus === "deleted"
        ) {
          throw new Error("Nexus repository binding is unavailable");
        }
        // Promotion closes this staging key. Reusing it would silently make
        // later one-off attachments permanent, so callers must mint a fresh
        // draft key for every new temporary source.
        if (existing.repository.repositoryKind === "durable") {
          throw new Error("Nexus repository binding is unavailable");
        }
        const [refreshed] = await tx
          .update(knowledgeRepositories)
          .set({
            isPublic: false,
            lifecycleStatus: "active",
            retentionDays: policy.nexusAttachmentRetentionDays,
            expiresAt,
            updatedAt: now,
          })
          .where(eq(knowledgeRepositories.id, existing.repository.id))
          .returning();
        if (!refreshed) {
          throw new Error("Failed to refresh Nexus attachment repository");
        }
        return resultFromRows(existing.binding, refreshed, false);
      }

      const [repository] = await tx
        .insert(knowledgeRepositories)
        .values({
          name: "Nexus attachments",
          description: "Private temporary sources attached to a Nexus conversation.",
          ownerId: input.ownerId,
          isPublic: false,
          repositoryKind: "ephemeral",
          lifecycleStatus: "active",
          retentionDays: policy.nexusAttachmentRetentionDays,
          expiresAt,
          metadata: {
            hidden: true,
            nexusManaged: true,
          },
        })
        .returning();
      if (!repository) {
        throw new Error("Failed to create Nexus attachment repository");
      }

      const [binding] = await tx
        .insert(nexusRepositoryBindings)
        .values({
          ownerId: input.ownerId,
          draftKey: input.draftKey,
          repositoryId: repository.id,
        })
        .returning();
      if (!binding) {
        throw new Error("Failed to bind Nexus attachment repository");
      }
      return resultFromRows(binding, repository, true);
    },
    "nexus.getOrCreateEphemeralRepository"
  );
}

/**
 * Attach a staged draft to its conversation. Both application checks and the
 * migration's composite foreign key require one owner across all three rows.
 */
export async function bindNexusRepositoryToConversation(
  input: BindNexusRepositoryInput
): Promise<NexusRepositoryBindingResult> {
  assertPositiveId(input.ownerId, "Owner id");
  assertUuid(input.draftKey, "Draft key");
  assertUuid(input.conversationId, "Conversation id");
  const now = input.now ?? new Date();

  return executeTransaction(
    async (tx) => {
      const [conversation] = await tx
        .select({ id: nexusConversations.id })
        .from(nexusConversations)
        .where(
          and(
            eq(nexusConversations.id, input.conversationId),
            eq(nexusConversations.userId, input.ownerId)
          )
        )
        .limit(1);
      if (!conversation) {
        throw new Error("Nexus repository binding was not found");
      }

      const [existing] = await tx
        .select({
          binding: nexusRepositoryBindings,
          repository: knowledgeRepositories,
        })
        .from(nexusRepositoryBindings)
        .innerJoin(
          knowledgeRepositories,
          eq(
            knowledgeRepositories.id,
            nexusRepositoryBindings.repositoryId
          )
        )
        .where(
          and(
            eq(nexusRepositoryBindings.ownerId, input.ownerId),
            eq(nexusRepositoryBindings.draftKey, input.draftKey)
          )
        )
        .limit(1)
        .for("update");
      if (
        !existing ||
        (existing.binding.conversationId != null &&
          existing.binding.conversationId !== input.conversationId) ||
        existing.repository.lifecycleStatus !== "active" ||
        (existing.repository.expiresAt != null &&
          existing.repository.expiresAt.getTime() <= now.getTime()) ||
        !["durable", "ephemeral"].includes(existing.repository.repositoryKind)
      ) {
        throw new Error("Nexus repository binding was not found");
      }

      const [binding] = await tx
        .update(nexusRepositoryBindings)
        .set({
          conversationId: input.conversationId,
          boundAt: existing.binding.boundAt ?? now,
          updatedAt: now,
        })
        .where(eq(nexusRepositoryBindings.id, existing.binding.id))
        .returning();
      if (!binding) {
        throw new Error("Nexus repository binding was not found");
      }
      return resultFromRows(binding, existing.repository, false);
    },
    "nexus.bindEphemeralRepository"
  );
}

/** Check conversation ownership before allocating temporary repository state. */
export async function nexusConversationBelongsToOwner(
  input: NexusConversationOwnershipInput
): Promise<boolean> {
  assertPositiveId(input.ownerId, "Owner id");
  assertUuid(input.conversationId, "Conversation id");
  const [conversation] = await executeQuery(
    (db) =>
      db
        .select({ id: nexusConversations.id })
        .from(nexusConversations)
        .where(
          and(
            eq(nexusConversations.id, input.conversationId),
            eq(nexusConversations.userId, input.ownerId)
          )
        )
        .limit(1),
    "nexus.verifyConversationOwnership"
  );
  return conversation != null;
}

/**
 * Compensate a failed first upload without deleting a repository another
 * concurrent request has started using.
 */
export async function discardNexusEphemeralRepository(
  input: DiscardNexusEphemeralRepositoryInput
): Promise<boolean> {
  assertPositiveId(input.ownerId, "Owner id");
  assertPositiveId(input.repositoryId, "Repository id");
  assertUuid(input.bindingId, "Binding id");

  return executeTransaction(
    async (tx) => {
      const [owned] = await tx
        .select({ id: knowledgeRepositories.id })
        .from(nexusRepositoryBindings)
        .innerJoin(
          knowledgeRepositories,
          eq(
            knowledgeRepositories.id,
            nexusRepositoryBindings.repositoryId
          )
        )
        .where(
          and(
            eq(nexusRepositoryBindings.id, input.bindingId),
            eq(nexusRepositoryBindings.ownerId, input.ownerId),
            eq(nexusRepositoryBindings.repositoryId, input.repositoryId),
            eq(knowledgeRepositories.ownerId, input.ownerId),
            eq(knowledgeRepositories.repositoryKind, "ephemeral")
          )
        )
        .limit(1)
        .for("update");
      if (!owned) return false;

      const [item] = await tx
        .select({ id: repositoryItems.id })
        .from(repositoryItems)
        .where(eq(repositoryItems.repositoryId, input.repositoryId))
        .limit(1);
      const [activeUpload] = await tx
        .select({ id: repositoryUploadSessions.id })
        .from(repositoryUploadSessions)
        .where(
          and(
            eq(repositoryUploadSessions.repositoryId, input.repositoryId),
            inArray(repositoryUploadSessions.status, [
              "initiated",
              "uploading",
              "uploaded",
              "completed",
            ])
          )
        )
        .limit(1);
      if (item || activeUpload) return false;

      const deleted = await tx
        .delete(knowledgeRepositories)
        .where(
          and(
            eq(knowledgeRepositories.id, input.repositoryId),
            eq(knowledgeRepositories.ownerId, input.ownerId),
            eq(knowledgeRepositories.repositoryKind, "ephemeral")
          )
        )
        .returning({ id: knowledgeRepositories.id });
      return deleted.length === 1;
    },
    "nexus.discardFailedEphemeralRepository"
  );
}

/** Resolve only repositories currently usable by the conversation owner. */
export async function resolveNexusConversationRepositoryIds(
  input: ResolveNexusRepositoriesInput
): Promise<number[]> {
  assertPositiveId(input.ownerId, "Owner id");
  assertUuid(input.conversationId, "Conversation id");
  const now = input.now ?? new Date();
  const rows = await executeQuery(
    (db) =>
      db
        .selectDistinct({ id: knowledgeRepositories.id })
        .from(nexusRepositoryBindings)
        .innerJoin(
          knowledgeRepositories,
          eq(
            knowledgeRepositories.id,
            nexusRepositoryBindings.repositoryId
          )
        )
        .where(
          and(
            eq(nexusRepositoryBindings.ownerId, input.ownerId),
            eq(
              nexusRepositoryBindings.conversationId,
              input.conversationId
            ),
            eq(knowledgeRepositories.ownerId, input.ownerId),
            eq(knowledgeRepositories.lifecycleStatus, "active"),
            inArray(knowledgeRepositories.repositoryKind, [
              "durable",
              "ephemeral",
            ]),
            or(
              isNull(knowledgeRepositories.expiresAt),
              gt(knowledgeRepositories.expiresAt, now)
            )
          )
        )
        .orderBy(knowledgeRepositories.id),
    "nexus.resolveConversationRepositoryIds"
  );
  return rows.map((row) => row.id);
}

/**
 * Resolve an active owner-bound repository before an upload has produced an
 * item. Missing, foreign, and expired bindings intentionally share null.
 */
export async function resolveNexusRepositoryBinding(
  input: ResolveNexusRepositoryBindingInput
): Promise<NexusRepositoryBindingResult | null> {
  assertPositiveId(input.ownerId, "Owner id");
  assertUuid(input.bindingId, "Binding id");
  const now = input.now ?? new Date();
  const [row] = await executeQuery(
    (db) =>
      db
        .select({
          binding: nexusRepositoryBindings,
          repository: knowledgeRepositories,
        })
        .from(nexusRepositoryBindings)
        .innerJoin(
          knowledgeRepositories,
          eq(
            knowledgeRepositories.id,
            nexusRepositoryBindings.repositoryId
          )
        )
        .where(
          and(
            eq(nexusRepositoryBindings.id, input.bindingId),
            eq(nexusRepositoryBindings.ownerId, input.ownerId),
            eq(knowledgeRepositories.ownerId, input.ownerId),
            eq(knowledgeRepositories.lifecycleStatus, "active"),
            inArray(knowledgeRepositories.repositoryKind, [
              "durable",
              "ephemeral",
            ]),
            or(
              isNull(knowledgeRepositories.expiresAt),
              gt(knowledgeRepositories.expiresAt, now)
            )
          )
        )
        .limit(1),
    "nexus.resolveRepositoryBinding"
  );
  return row ? resultFromRows(row.binding, row.repository, false) : null;
}

/**
 * Resolve an opaque client marker without accepting a repository id from the
 * caller. Missing, foreign, expired, and cross-repository pairs all collapse to
 * null so routes can return one non-disclosing not-found response.
 */
export async function resolveNexusAttachmentReference(
  input: ResolveNexusAttachmentReferenceInput
): Promise<NexusAttachmentReferenceResolution | null> {
  assertPositiveId(input.ownerId, "Owner id");
  assertUuid(input.bindingId, "Binding id");
  assertPositiveId(input.itemId, "Item id");
  const now = input.now ?? new Date();
  const [row] = await executeQuery(
    (db) =>
      db
        .select({
          bindingId: nexusRepositoryBindings.id,
          draftKey: nexusRepositoryBindings.draftKey,
          conversationId: nexusRepositoryBindings.conversationId,
          repositoryId: knowledgeRepositories.id,
          itemId: repositoryItems.id,
          itemType: repositoryItems.type,
          itemName: repositoryItems.name,
          currentVersionId: repositoryItems.currentVersionId,
          processingStatus: repositoryItems.processingStatus,
        })
        .from(nexusRepositoryBindings)
        .innerJoin(
          knowledgeRepositories,
          eq(
            knowledgeRepositories.id,
            nexusRepositoryBindings.repositoryId
          )
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.repositoryId, knowledgeRepositories.id)
        )
        .where(
          and(
            eq(nexusRepositoryBindings.id, input.bindingId),
            eq(nexusRepositoryBindings.ownerId, input.ownerId),
            eq(knowledgeRepositories.ownerId, input.ownerId),
            eq(knowledgeRepositories.lifecycleStatus, "active"),
            inArray(knowledgeRepositories.repositoryKind, [
              "durable",
              "ephemeral",
            ]),
            or(
              isNull(knowledgeRepositories.expiresAt),
              gt(knowledgeRepositories.expiresAt, now)
            ),
            eq(repositoryItems.id, input.itemId),
            eq(repositoryItems.lifecycleStatus, "active")
          )
        )
        .limit(1),
    "nexus.resolveAttachmentReference"
  );
  return row ?? null;
}

/**
 * Re-resolve canonical image bytes after the attachment binding transaction.
 * The image-generation special route has no repository tool loop, so it must
 * source pixels from the owner-bound immutable version instead of trusting an
 * unrelated inline image part carried beside an opaque marker.
 */
export async function resolveNexusAttachmentImageSources(input: {
  ownerId: number;
  conversationId: string;
  references: NexusAttachmentReference[];
  now?: Date;
}): Promise<NexusAttachmentImageSource[] | null> {
  assertPositiveId(input.ownerId, "Owner id");
  assertUuid(input.conversationId, "Conversation id");
  if (input.references.length === 0 || input.references.length > 20) {
    throw new Error("Between 1 and 20 Nexus attachment references are required");
  }
  const uniqueReferences = [
    ...new Map(
      input.references.map((reference) => [
        `${reference.bindingId}:${reference.itemId}`,
        reference,
      ])
    ).values(),
  ];
  for (const reference of uniqueReferences) {
    assertUuid(reference.bindingId, "Binding id");
    assertPositiveId(reference.itemId, "Item id");
  }
  const now = input.now ?? new Date();
  const referencePredicate = or(
    ...uniqueReferences.map((reference) =>
      and(
        eq(nexusRepositoryBindings.id, reference.bindingId),
        eq(repositoryItems.id, reference.itemId)
      )
    )
  );
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          bindingId: nexusRepositoryBindings.id,
          repositoryId: knowledgeRepositories.id,
          itemId: repositoryItems.id,
          itemVersionId: repositoryItemVersions.id,
          objectKey: repositoryItemVersions.objectKey,
          declaredContentType: repositoryItemVersions.declaredContentType,
          detectedContentType: repositoryItemVersions.detectedContentType,
          byteSize: repositoryItemVersions.byteSize,
        })
        .from(nexusRepositoryBindings)
        .innerJoin(
          knowledgeRepositories,
          eq(
            knowledgeRepositories.id,
            nexusRepositoryBindings.repositoryId
          )
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.repositoryId, knowledgeRepositories.id)
        )
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryItems.currentVersionId)
        )
        .where(
          and(
            referencePredicate,
            eq(nexusRepositoryBindings.ownerId, input.ownerId),
            eq(nexusRepositoryBindings.conversationId, input.conversationId),
            eq(knowledgeRepositories.ownerId, input.ownerId),
            eq(knowledgeRepositories.lifecycleStatus, "active"),
            inArray(knowledgeRepositories.repositoryKind, [
              "durable",
              "ephemeral",
            ]),
            or(
              isNull(knowledgeRepositories.expiresAt),
              gt(knowledgeRepositories.expiresAt, now)
            ),
            eq(repositoryItems.type, "image"),
            eq(repositoryItems.lifecycleStatus, "active"),
            eq(repositoryItems.processingStatus, "embedded"),
            eq(repositoryItemVersions.storageStatus, "available"),
            inArray(repositoryItemVersions.inspectionStatus, [
              "clean",
              "not_required",
            ]),
            eq(repositoryItemVersions.processingStatus, "completed"),
            isNotNull(repositoryItemVersions.objectKey)
          )
        ),
    "nexus.resolveAttachmentImageSources"
  );
  const rowsByReference = new Map(
    rows.map((row) => [`${row.bindingId}:${row.itemId}`, row])
  );
  if (
    rowsByReference.size !== uniqueReferences.length ||
    uniqueReferences.some(
      (reference) =>
        !rowsByReference.has(`${reference.bindingId}:${reference.itemId}`)
    )
  ) {
    return null;
  }
  return uniqueReferences.map((reference) => {
    const row = rowsByReference.get(
      `${reference.bindingId}:${reference.itemId}`
    );
    if (!row?.objectKey) {
      throw new Error("Canonical image source unexpectedly had no object key");
    }
    return {
      ...row,
      objectKey: row.objectKey,
    };
  });
}

/**
 * Resolve an owner-bound item for promotion, including an expired ephemeral
 * repository that remains inside its recovery grace interval. Retrieval keeps
 * using the stricter active-only resolver above.
 */
export async function resolveNexusAttachmentForPromotion(
  input: ResolveNexusAttachmentForPromotionInput
): Promise<NexusAttachmentReferenceResolution | null> {
  assertPositiveId(input.ownerId, "Owner id");
  assertUuid(input.bindingId, "Binding id");
  assertPositiveId(input.itemId, "Item id");
  const now = input.now ?? new Date();
  const policy = await resolvePolicy(input.policy);
  const [row] = await executeQuery(
    (db) =>
      db
        .select({
          bindingId: nexusRepositoryBindings.id,
          draftKey: nexusRepositoryBindings.draftKey,
          conversationId: nexusRepositoryBindings.conversationId,
          repositoryId: knowledgeRepositories.id,
          repositoryKind: knowledgeRepositories.repositoryKind,
          lifecycleStatus: knowledgeRepositories.lifecycleStatus,
          expiresAt: knowledgeRepositories.expiresAt,
          itemId: repositoryItems.id,
          itemType: repositoryItems.type,
          itemName: repositoryItems.name,
          currentVersionId: repositoryItems.currentVersionId,
          processingStatus: repositoryItems.processingStatus,
        })
        .from(nexusRepositoryBindings)
        .innerJoin(
          knowledgeRepositories,
          eq(
            knowledgeRepositories.id,
            nexusRepositoryBindings.repositoryId
          )
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.repositoryId, knowledgeRepositories.id)
        )
        .where(
          and(
            eq(nexusRepositoryBindings.id, input.bindingId),
            eq(nexusRepositoryBindings.ownerId, input.ownerId),
            eq(knowledgeRepositories.ownerId, input.ownerId),
            inArray(knowledgeRepositories.repositoryKind, [
              "durable",
              "ephemeral",
            ]),
            eq(repositoryItems.id, input.itemId),
            eq(repositoryItems.lifecycleStatus, "active")
          )
        )
        .limit(1),
    "nexus.resolveAttachmentForPromotion"
  );
  if (
    !row ||
    !isNexusRepositoryPromotable({
      repositoryKind: row.repositoryKind,
      lifecycleStatus: row.lifecycleStatus,
      expiresAt: row.expiresAt,
      deletionGraceDays: policy.deletionGraceDays,
      now,
    })
  ) {
    return null;
  }
  return {
    bindingId: row.bindingId,
    draftKey: row.draftKey,
    conversationId: row.conversationId,
    repositoryId: row.repositoryId,
    itemId: row.itemId,
    itemType: row.itemType,
    itemName: row.itemName,
    currentVersionId: row.currentVersionId,
    processingStatus: row.processingStatus,
  };
}

/**
 * Atomically bind every opaque attachment marker in a user turn. One invalid
 * pair aborts the whole operation, so a first message cannot partially attach
 * content or probe another user's sequential item ids.
 */
export async function bindNexusAttachmentReferencesToConversation(
  input: BindNexusAttachmentReferencesInput
): Promise<number[]> {
  assertPositiveId(input.ownerId, "Owner id");
  assertUuid(input.conversationId, "Conversation id");
  if (input.references.length === 0 || input.references.length > 20) {
    throw new Error("Between 1 and 20 Nexus attachment references are required");
  }
  for (const reference of input.references) {
    assertUuid(reference.bindingId, "Binding id");
    assertPositiveId(reference.itemId, "Item id");
  }
  const uniqueReferences = [
    ...new Map(
      input.references.map((reference) => [
        `${reference.bindingId}:${reference.itemId}`,
        reference,
      ])
    ).values(),
  ];
  const now = input.now ?? new Date();

  return executeTransaction(
    async (tx) => {
      const [conversation] = await tx
        .select({ id: nexusConversations.id })
        .from(nexusConversations)
        .where(
          and(
            eq(nexusConversations.id, input.conversationId),
            eq(nexusConversations.userId, input.ownerId)
          )
        )
        .limit(1);
      if (!conversation) {
        throw new Error("Nexus attachment reference was not found");
      }

      const rows = await tx
        .select({
          bindingId: nexusRepositoryBindings.id,
          conversationId: nexusRepositoryBindings.conversationId,
          repositoryId: knowledgeRepositories.id,
          itemId: repositoryItems.id,
        })
        .from(nexusRepositoryBindings)
        .innerJoin(
          knowledgeRepositories,
          eq(
            knowledgeRepositories.id,
            nexusRepositoryBindings.repositoryId
          )
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.repositoryId, knowledgeRepositories.id)
        )
        .where(
          and(
            eq(nexusRepositoryBindings.ownerId, input.ownerId),
            eq(knowledgeRepositories.ownerId, input.ownerId),
            eq(knowledgeRepositories.lifecycleStatus, "active"),
            inArray(knowledgeRepositories.repositoryKind, [
              "durable",
              "ephemeral",
            ]),
            or(
              isNull(knowledgeRepositories.expiresAt),
              gt(knowledgeRepositories.expiresAt, now)
            ),
            eq(repositoryItems.lifecycleStatus, "active"),
            or(
              ...uniqueReferences.map((reference) =>
                and(
                  eq(nexusRepositoryBindings.id, reference.bindingId),
                  eq(repositoryItems.id, reference.itemId)
                )
              )
            )
          )
        )
        .for("update");

      const found = new Set(
        rows.map((row) => `${row.bindingId}:${row.itemId}`)
      );
      const valid =
        found.size === uniqueReferences.length &&
        uniqueReferences.every((reference) =>
          found.has(`${reference.bindingId}:${reference.itemId}`)
        ) &&
        rows.every(
          (row) =>
            row.conversationId == null ||
            row.conversationId === input.conversationId
        );
      if (!valid) {
        throw new Error("Nexus attachment reference was not found");
      }

      const bindingIds = [...new Set(rows.map((row) => row.bindingId))];
      await tx
        .update(nexusRepositoryBindings)
        .set({
          conversationId: input.conversationId,
          boundAt: now,
          updatedAt: now,
        })
        .where(inArray(nexusRepositoryBindings.id, bindingIds));
      return [...new Set(rows.map((row) => row.repositoryId))].sort(
        (left, right) => left - right
      );
    },
    "nexus.bindAttachmentReferences"
  );
}

/**
 * Promote without copying data so immutable version/chunk identities and
 * citations remain stable. An expired repository is recoverable only during
 * the configured grace interval and before purge has claimed it.
 */
export async function promoteNexusRepository(
  input: PromoteNexusRepositoryInput
): Promise<NexusRepositoryBindingResult> {
  assertPositiveId(input.ownerId, "Owner id");
  assertPositiveId(input.repositoryId, "Repository id");
  const name = assertRepositoryName(input.name);
  const now = input.now ?? new Date();
  const policy = await resolvePolicy(input.policy);

  return executeTransaction(
    async (tx) => {
      const [existing] = await tx
        .select({
          binding: nexusRepositoryBindings,
          repository: knowledgeRepositories,
        })
        .from(nexusRepositoryBindings)
        .innerJoin(
          knowledgeRepositories,
          eq(
            knowledgeRepositories.id,
            nexusRepositoryBindings.repositoryId
          )
        )
        .where(
          and(
            eq(nexusRepositoryBindings.ownerId, input.ownerId),
            eq(nexusRepositoryBindings.repositoryId, input.repositoryId),
            eq(knowledgeRepositories.ownerId, input.ownerId)
          )
        )
        .limit(1)
        .for("update");
      if (!existing) {
        throw new Error("Nexus attachment repository was not found");
      }
      if (
        !isNexusRepositoryPromotable({
          repositoryKind: existing.repository.repositoryKind,
          lifecycleStatus: existing.repository.lifecycleStatus,
          expiresAt: existing.repository.expiresAt,
          deletionGraceDays: policy.deletionGraceDays,
          now,
        })
      ) {
        throw new Error("Nexus attachment repository was not found");
      }
      if (existing.repository.repositoryKind === "durable") {
        // Promotion is idempotent. A replay can occur after the client reloads
        // the conversation, but it must not turn the original promotion name
        // into an implicit repository rename operation.
        return resultFromRows(existing.binding, existing.repository, false);
      }
      if (
        existing.repository.repositoryKind !== "ephemeral" ||
        !existing.repository.expiresAt
      ) {
        throw new Error("Nexus attachment repository was not found");
      }

      const metadata = existing.repository.metadata ?? {};
      const [promoted] = await tx
        .update(knowledgeRepositories)
        .set({
          name,
          isPublic: false,
          repositoryKind: "durable",
          lifecycleStatus: "active",
          retentionDays: null,
          expiresAt: null,
          metadata: {
            ...metadata,
            hidden: false,
            promotedAt: now.toISOString(),
          },
          updatedAt: now,
        })
        .where(eq(knowledgeRepositories.id, input.repositoryId))
        .returning();
      if (!promoted) {
        throw new Error("Nexus attachment repository was not found");
      }
      return resultFromRows(existing.binding, promoted, false);
    },
    "nexus.promoteEphemeralRepository"
  );
}
