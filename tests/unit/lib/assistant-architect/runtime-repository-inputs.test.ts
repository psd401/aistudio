/** @jest-environment node */

const mockResolveNexusAttachmentReference = jest.fn();

jest.mock("@/lib/nexus/ephemeral-repository-service", () => ({
  resolveNexusAttachmentReference: (...args: unknown[]) =>
    mockResolveNexusAttachmentReference(...args),
}));

import { resolveAssistantRuntimeRepositoryInputs } from "@/lib/assistant-architect/runtime-repository-inputs";

const bindingId = "123e4567-e89b-42d3-a456-426614174000";
const marker = `[[repository-attachment:v1:${bindingId}:44:plan.pdf]]`;

describe("Assistant Architect runtime repository inputs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveNexusAttachmentReference.mockResolvedValue({
      repositoryId: 9,
      itemName: "authoritative-plan.pdf",
    });
  });

  it("resolves opaque inputs only through the executing owner", async () => {
    await expect(
      resolveAssistantRuntimeRepositoryInputs({ plan: marker }, 7)
    ).resolves.toEqual({
      repositoryIds: [9],
      queryContext: "Attached source: authoritative-plan.pdf",
      references: [
        { bindingId, itemId: 44, name: "authoritative-plan.pdf" },
      ],
      modelInputs: {
        plan: "[Attached repository content: authoritative-plan.pdf]",
      },
    });
    expect(mockResolveNexusAttachmentReference).toHaveBeenCalledWith({
      ownerId: 7,
      bindingId,
      itemId: 44,
    });
  });

  it("fails the entire run when a reference is foreign or expired", async () => {
    mockResolveNexusAttachmentReference.mockResolvedValue(null);
    await expect(
      resolveAssistantRuntimeRepositoryInputs({ plan: marker }, 8)
    ).rejects.toThrow("unavailable");
  });

  it("never trusts the caller-carried marker name for model provenance", async () => {
    const forgedNameMarker =
      `[[repository-attachment:v1:${bindingId}:44:forged-secret-name.pdf]]`;

    const resolved = await resolveAssistantRuntimeRepositoryInputs(
      { plan: forgedNameMarker },
      7
    );

    expect(JSON.stringify(resolved)).not.toContain("forged-secret-name.pdf");
    expect(resolved.modelInputs).toEqual({
      plan: "[Attached repository content: authoritative-plan.pdf]",
    });
  });
});
