import {
  CAPTURE_SOURCE_ORIGIN_LIMIT,
  contentSourceRefSchema,
  normalizeCaptureSourceOrigin,
} from "@/lib/content/source-ref";

const VALID_CAPTURE = {
  type: "capture" as const,
  provider: "atrium-capture",
  externalId: "capture-session-123",
  clientSurface: "browser" as const,
  clientVersion: "1.0.0",
  capturedAt: "2026-07-22T20:15:00-07:00",
};

describe("Atrium capture source references (#1290)", () => {
  afterEach(() => {
    delete process.env.ATRIUM_CAPTURE_SOURCE_ORIGINS_ENABLED;
  });

  it("normalizes full URLs to deduplicated origins and canonicalizes capturedAt", () => {
    const parsed = contentSourceRefSchema.parse({
      ...VALID_CAPTURE,
      sourceOrigins: [
        "https://example.edu/private/path?student=1#section",
        "https://example.edu/another",
        "http://127.0.0.1:3100/local",
      ],
    });

    expect(parsed).toEqual({
      ...VALID_CAPTURE,
      capturedAt: "2026-07-23T03:15:00.000Z",
      sourceOrigins: ["https://example.edu", "http://127.0.0.1:3100"],
    });
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:secret@example.edu/path",
    "not a url",
  ])("rejects unsafe origin %s", (value) => {
    expect(() => normalizeCaptureSourceOrigin(value)).toThrow();
    expect(
      contentSourceRefSchema.safeParse({
        ...VALID_CAPTURE,
        sourceOrigins: [value],
      }).success
    ).toBe(false);
  });

  it("rejects unknown fields, oversized origin lists, and unknown surfaces", () => {
    expect(
      contentSourceRefSchema.safeParse({ ...VALID_CAPTURE, selector: "#password" })
        .success
    ).toBe(false);
    expect(
      contentSourceRefSchema.safeParse({
        ...VALID_CAPTURE,
        sourceOrigins: Array.from(
          { length: CAPTURE_SOURCE_ORIGIN_LIMIT + 1 },
          (_, index) => `https://site-${index}.example.edu`
        ),
      }).success
    ).toBe(false);
    expect(
      contentSourceRefSchema.safeParse({
        ...VALID_CAPTURE,
        clientSurface: "windows",
      }).success
    ).toBe(false);
  });

  it("fails closed when district policy disables origin retention", () => {
    process.env.ATRIUM_CAPTURE_SOURCE_ORIGINS_ENABLED = "false";
    expect(
      contentSourceRefSchema.safeParse({
        ...VALID_CAPTURE,
        sourceOrigins: ["https://example.edu/path"],
      }).success
    ).toBe(false);
  });

  it("keeps established source-ref variants backward compatible", () => {
    expect(
      contentSourceRefSchema.parse({
        type: "upload",
        uploadId: "upload-1",
        filename: "guide.md",
      })
    ).toEqual({ type: "upload", uploadId: "upload-1", filename: "guide.md" });
    expect(
      contentSourceRefSchema.parse({
        type: "object",
        objectId: "11111111-2222-4333-8444-555555555555",
      })
    ).toEqual({
      type: "object",
      objectId: "11111111-2222-4333-8444-555555555555",
    });
    expect(
      contentSourceRefSchema.parse({
        type: "chat",
        conversationId: "22222222-3333-4444-8555-666666666666",
      })
    ).toEqual({
      type: "chat",
      conversationId: "22222222-3333-4444-8555-666666666666",
    });
    expect(contentSourceRefSchema.parse({ type: "none" })).toEqual({
      type: "none",
    });
  });

  it("declares the owner-scoped unique capture index in the migration", () => {
    const migration = require("node:fs").readFileSync(
      "infra/database/schema/126-atrium-capture-source-ref.sql",
      "utf8"
    ) as string;
    expect(migration).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_content_capture_source"
    );
    expect(migration).toContain("owner_user_id");
    expect(migration).toContain("source_ref->>'type' = 'capture'");
  });
});
