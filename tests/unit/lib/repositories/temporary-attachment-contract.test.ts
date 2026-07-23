import {
  buildTemporaryAttachmentMarker,
  parseTemporaryAttachmentMarkers,
  prepareTemporaryAttachmentValueForModel,
  removeTemporaryAttachmentMarkers,
  stripTemporaryAttachmentMarkers,
  temporaryAttachmentReferencesFromValue,
} from "@/lib/repositories/temporary-attachment-contract";

const bindingId = "123e4567-e89b-42d3-a456-426614174000";

describe("temporary attachment contract", () => {
  it("round-trips an opaque reference without source content", () => {
    const marker = buildTemporaryAttachmentMarker({
      bindingId,
      itemId: 42,
      name: "Student plan [final].pdf",
    });

    expect(marker).not.toContain("Student plan [final].pdf");
    expect(parseTemporaryAttachmentMarkers(marker)).toEqual([
      {
        bindingId,
        itemId: 42,
        name: "Student plan (final).pdf",
      },
    ]);
  });

  it("deduplicates valid references and ignores forged shapes", () => {
    const marker = buildTemporaryAttachmentMarker({
      bindingId,
      itemId: 7,
      name: "notes.md",
    });

    expect(
      parseTemporaryAttachmentMarkers(
        `${marker}\n${marker}\n[[repository-attachment:v1:not-a-uuid:1:x]]`
      )
    ).toHaveLength(1);
  });

  it("replaces opaque markers with a bounded model-facing label", () => {
    const marker = buildTemporaryAttachmentMarker({
      bindingId,
      itemId: 9,
      name: "handbook.pdf",
    });

    expect(stripTemporaryAttachmentMarkers(`Read ${marker}`)).toBe(
      "Read [Attached repository content: handbook.pdf]"
    );
  });

  it("removes opaque markers from user-visible text", () => {
    const marker = buildTemporaryAttachmentMarker({
      bindingId,
      itemId: 10,
      name: "visible.pdf",
    });

    expect(removeTemporaryAttachmentMarkers(`Use this file.\n${marker}`)).toBe(
      "Use this file.\n"
    );
  });

  it("finds references in bounded nested input values", () => {
    const marker = buildTemporaryAttachmentMarker({
      bindingId,
      itemId: 11,
      name: "nested.txt",
    });
    expect(
      temporaryAttachmentReferencesFromValue({
        first: [{ value: marker }],
      })
    ).toEqual([
      {
        bindingId,
        itemId: 11,
        name: "nested.txt",
      },
    ]);
  });

  it("removes opaque identifiers from structured model inputs", () => {
    const marker = buildTemporaryAttachmentMarker({
      bindingId,
      itemId: 12,
      name: "private plan.pdf",
    });

    const prepared = prepareTemporaryAttachmentValueForModel({
      source: marker,
      nested: [{ note: `Review ${marker}` }],
    });
    expect(prepared).toEqual({
      source: "[Attached repository content: private plan.pdf]",
      nested: [
        {
          note: "Review [Attached repository content: private plan.pdf]",
        },
      ],
    });
    expect(JSON.stringify(prepared)).not.toContain(bindingId);
    expect(JSON.stringify(prepared)).not.toContain(":12:");
  });
});
