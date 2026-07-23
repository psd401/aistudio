/** @jest-environment node */

import {
  bindNexusAttachmentReferencesToConversation,
  getOrCreateNexusEphemeralRepository,
  isNexusRepositoryPromotable,
  nexusRepositoryExpiresAt,
  nexusRepositoryGraceEndsAt,
  promoteNexusRepository,
  resolveNexusAttachmentReference,
  resolveNexusRepositoryBinding,
} from "@/lib/nexus/ephemeral-repository-service";

const NOW = new Date("2026-07-23T12:00:00.000Z");

describe("Nexus ephemeral repository policy", () => {
  it("calculates the configured retention and deletion grace boundaries", () => {
    const expiresAt = nexusRepositoryExpiresAt(NOW, 30);

    expect(expiresAt.toISOString()).toBe("2026-08-22T12:00:00.000Z");
    expect(nexusRepositoryGraceEndsAt(expiresAt, 7).toISOString()).toBe(
      "2026-08-29T12:00:00.000Z"
    );
  });

  it.each([0, 3651, 1.5])(
    "rejects an unsafe attachment retention value of %s",
    (retentionDays) => {
      expect(() => nexusRepositoryExpiresAt(NOW, retentionDays)).toThrow(
        "Nexus attachment retention must be between 1 and 3650 days"
      );
    }
  );

  it.each([0, 366, 1.5])(
    "rejects an unsafe deletion grace value of %s",
    (deletionGraceDays) => {
      expect(() =>
        nexusRepositoryGraceEndsAt(NOW, deletionGraceDays)
      ).toThrow("Content deletion grace must be between 1 and 365 days");
    }
  );

  it("validates opaque owner, draft, binding, and item identifiers before database access", async () => {
    await expect(
      getOrCreateNexusEphemeralRepository({
        ownerId: 0,
        draftKey: "11111111-2222-4333-8444-555555555555",
        policy: {
          nexusAttachmentRetentionDays: 30,
          deletionGraceDays: 7,
        },
      })
    ).rejects.toThrow("Owner id must be a positive safe integer");

    await expect(
      resolveNexusAttachmentReference({
        ownerId: 1,
        bindingId: "not-a-uuid",
        itemId: 4,
      })
    ).rejects.toThrow("Binding id must be a valid UUID");

    await expect(
      resolveNexusRepositoryBinding({
        ownerId: 1,
        bindingId: "not-a-uuid",
      })
    ).rejects.toThrow("Binding id must be a valid UUID");

    await expect(
      bindNexusAttachmentReferencesToConversation({
        ownerId: 1,
        conversationId: "11111111-2222-4333-8444-555555555555",
        references: [],
      })
    ).rejects.toThrow(
      "Between 1 and 20 Nexus attachment references are required"
    );
  });

  it("rejects an empty promotion name before loading policy or repository state", async () => {
    await expect(
      promoteNexusRepository({
        ownerId: 1,
        repositoryId: 2,
        name: "   ",
      })
    ).rejects.toThrow(
      "Repository name must contain between 1 and 500 characters"
    );
  });

  it("allows ephemeral promotion through grace but not after purge eligibility", () => {
    const expiresAt = new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000);

    expect(
      isNexusRepositoryPromotable({
        repositoryKind: "ephemeral",
        lifecycleStatus: "expired",
        expiresAt,
        deletionGraceDays: 7,
        now: NOW,
      })
    ).toBe(true);
    expect(
      isNexusRepositoryPromotable({
        repositoryKind: "ephemeral",
        lifecycleStatus: "expired",
        expiresAt,
        deletionGraceDays: 6,
        now: NOW,
      })
    ).toBe(false);
  });

  it("rejects an active repository whose stale expiry is past deletion grace", () => {
    expect(
      isNexusRepositoryPromotable({
        repositoryKind: "ephemeral",
        lifecycleStatus: "active",
        expiresAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000),
        deletionGraceDays: 7,
        now: NOW,
      })
    ).toBe(false);
  });

  it("never promotes a repository already claimed for deletion", () => {
    expect(
      isNexusRepositoryPromotable({
        repositoryKind: "ephemeral",
        lifecycleStatus: "deleting",
        expiresAt: new Date(NOW.getTime() + 1_000),
        deletionGraceDays: 7,
        now: NOW,
      })
    ).toBe(false);
  });
});
