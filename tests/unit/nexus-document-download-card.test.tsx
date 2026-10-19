/**
 * Nexus generated-file download card (Issue #1898).
 *
 * The card's href comes from a PERSISTED tool result that is replayed when the
 * conversation reloads, so `safeDownloadHref` is a trust boundary, not a tidy-up:
 * a corrupted or tampered message part must not become an off-site or
 * `javascript:` link rendered inside the user's own conversation. The state
 * resolver is the other half — it decides whether the user sees a working link,
 * a spinner, or an honest failure instead of a dead card.
 */

// `@assistant-ui/react` ships pure ESM that next/jest does not transform inside
// node_modules, so the module is stubbed (same approach as
// tests/unit/nexus-tool-group-workspace-signal.test.tsx). Only
// `makeAssistantToolUI` is reached at import time here; the exported pure
// helpers and the card component are what this suite exercises.
jest.mock("@assistant-ui/react", () => ({
  makeAssistantToolUI: () => () => null,
}));
jest.mock("@/components/assistant-ui/tool-args-recovery-boundary", () => ({
  ToolArgsRecoveryBoundary: ({ children }: { children: ReactNode }) =>
    children,
}));

import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import {
  DocumentDownloadCard,
  formatBytes,
  resolveDocumentCardState,
  safeDownloadHref,
} from "@/app/(protected)/nexus/_components/tools/document-download-ui";
import type { DocumentCreateToolResult } from "@/lib/tools/document-create-contract";

const VALID_PATH =
  "/api/nexus/documents/v2/nexus-documents/11111111-2222-3333-4444-555555555555/req-report.docx";

/**
 * The subset of assistant-ui's `ToolCallMessagePartStatus` the resolver reads.
 * Declared locally because the real type comes from the stubbed ESM module.
 */
type Status = Parameters<typeof resolveDocumentCardState>[0];

const COMPLETE = { type: "complete" } as Status;
const RUNNING = { type: "running" } as Status;
const ERRORED = { type: "incomplete", reason: "error" } as Status;

function ready(
  overrides: Partial<DocumentCreateToolResult> = {}
): DocumentCreateToolResult {
  return {
    ok: true,
    filename: "report.docx",
    format: "docx",
    bytes: 2048,
    downloadUrl: VALID_PATH,
    ...overrides,
  };
}

describe("safeDownloadHref", () => {
  it("accepts an app-relative path under the download route", () => {
    expect(safeDownloadHref(VALID_PATH)).toBe(VALID_PATH);
  });

  it.each([
    ["an absolute off-site URL", "https://evil.example/payload.docx"],
    ["a protocol-relative URL", "//evil.example/payload.docx"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["another app route", "/api/export-download?url=https://evil.example"],
    ["a backslash-smuggled host", "/api/nexus/documents/\\\\evil.example/x.docx"],
    ["a double-slash inside the path", "/api/nexus/documents//evil.example/x.docx"],
    ["a non-string", undefined],
  ])("rejects %s", (_label, candidate) => {
    expect(safeDownloadHref(candidate as string | undefined)).toBeNull();
  });
});

describe("formatBytes", () => {
  it("renders a readable size and never shows a real file as 0 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(2048)).toBe("2 KB");
    // Just over 1 KB must not round to "0 KB".
    expect(formatBytes(1100)).toBe("1 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("returns an empty label for a missing or nonsensical size", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});

describe("resolveDocumentCardState", () => {
  it("is pending while the call is still running", () => {
    expect(resolveDocumentCardState(RUNNING, undefined)).toEqual({
      kind: "pending",
    });
  });

  it("is ready with the href and filename for a usable result", () => {
    expect(resolveDocumentCardState(COMPLETE, ready())).toEqual({
      kind: "ready",
      href: VALID_PATH,
      filename: "report.docx",
    });
  });

  it("surfaces the tool's own error message for a returned failure", () => {
    const state = resolveDocumentCardState(COMPLETE, {
      ok: false,
      error: "The file could not be created: S3 unavailable",
    });
    expect(state).toEqual({
      kind: "failed",
      reason: "The file could not be created: S3 unavailable",
    });
  });

  it("fails for an errored part even when the payload claims success", () => {
    expect(resolveDocumentCardState(ERRORED, ready()).kind).toBe("failed");
  });

  it("fails rather than rendering a dead card when the link is unusable", () => {
    for (const result of [
      ready({ downloadUrl: "https://evil.example/x.docx" }),
      ready({ downloadUrl: undefined }),
      ready({ filename: undefined }),
      undefined,
    ]) {
      expect(resolveDocumentCardState(COMPLETE, result).kind).toBe("failed");
    }
  });
});

describe("DocumentDownloadCard", () => {
  it("shows the filename, type and size, and links to the download route", () => {
    render(
      <DocumentDownloadCard
        href={VALID_PATH}
        filename="report.docx"
        format="docx"
        bytes={2048}
      />
    );

    const link = screen.getByTestId("nexus-document-download");
    expect(link).toHaveAttribute("href", VALID_PATH);
    // The `download` attribute is what makes the click save the file rather
        // than navigate to it.
    expect(link).toHaveAttribute("download", "report.docx");
    expect(screen.getByText("report.docx")).toBeInTheDocument();
    expect(screen.getByTestId("nexus-document-meta")).toHaveTextContent(
      "Word document · 2 KB"
    );
  });

  it("labels each format a user would recognize", () => {
    for (const [format, label] of [
      ["pptx", "PowerPoint deck"],
      ["xlsx", "Excel spreadsheet"],
      ["pdf", "PDF"],
    ] as const) {
      const { unmount } = render(
        <DocumentDownloadCard
          href={VALID_PATH}
          filename={`file.${format}`}
          format={format}
          bytes={1024}
        />
      );
      // Scoped to the metadata line: a filename like "file.pdf" would otherwise
      // also match a loose text query for "PDF".
      expect(screen.getByTestId("nexus-document-meta")).toHaveTextContent(label);
      unmount();
    }
  });
});
