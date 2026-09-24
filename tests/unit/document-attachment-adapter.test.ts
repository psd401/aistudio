/**
 * Guards the document-only attachment adapter the Assistant Architect composer
 * uses (#1735 / FS#165437).
 *
 * Assistant Architect builds its `/api/nexus/chat` request body by hand
 * (`prepareAdapterMessages`), not through `AssistantChatTransport`, so it can only
 * carry assistant-ui content parts the route already understands verbatim — i.e.
 * `{ type: "text" }`. The image adapters emit `{ type: "image", image: <data-url> }`,
 * which only the AI SDK transport rewrites into an AI SDK `file` part; routed
 * through the hand-built body it would be dropped or rejected server-side.
 *
 * `CompositeAttachmentAdapter.accept` becomes the file picker's `accept`
 * attribute, so keeping images out of the composite is also what stops a user
 * from selecting one and watching it silently disappear.
 *
 * `@assistant-ui/react` ships pure ESM that next/jest does not transform inside
 * node_modules (see the note in jest.config.js), so the composite/simple adapters
 * are stubbed with the library's documented `accept`-union behaviour. What is
 * under test is which adapters *we* compose, which is exactly the thing a future
 * edit could regress.
 */

interface StubAdapter {
  accept: string;
}

jest.mock("@assistant-ui/react", () => ({
  CompositeAttachmentAdapter: class {
    public accept: string;
    constructor(public adapters: StubAdapter[]) {
      this.accept = adapters.map(adapter => adapter.accept).join(",");
    }
  },
  SimpleImageAttachmentAdapter: class {
    public accept = "image/*";
  },
  SimpleTextAttachmentAdapter: class {
    public accept = "text/plain";
  },
}));

import { createDocumentAttachmentAdapter } from "@/lib/nexus/enhanced-attachment-adapters";

describe("createDocumentAttachmentAdapter (#1735)", () => {
  const accept = createDocumentAttachmentAdapter().accept;
  const acceptedTypes = accept.split(",").map(entry => entry.trim());

  it("accepts the document formats the composer advertises", () => {
    for (const type of [
      "application/pdf",
      ".docx",
      ".xlsx",
      ".pptx",
      ".csv",
      ".md",
    ]) {
      expect(acceptedTypes).toContain(type);
    }
  });

  it("accepts plain text", () => {
    expect(acceptedTypes).toContain("text/plain");
  });

  it("does not advertise image types", () => {
    // A wildcard would also let images through the picker.
    expect(accept).not.toBe("*");
    expect(acceptedTypes.filter(type => type.startsWith("image/"))).toHaveLength(
      0,
    );
    for (const type of [".png", ".jpg", ".jpeg", ".gif", ".webp"]) {
      expect(acceptedTypes).not.toContain(type);
    }
  });
});
