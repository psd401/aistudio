/**
 * `useChatAttachments` is the single attachment wiring shared by Nexus, decision
 * capture, and Assistant Architect (#1735). These tests pin the contract all
 * three depend on: a stable adapter, a lazily-read conversation id, the
 * processing-spinner set, and the upload-failure toast.
 */

import { renderHook, act } from "@testing-library/react";
import type {
  AttachmentProcessingCallbacks,
  ChatAttachmentAdapterOptions,
} from "@/lib/attachments/chat-attachment-adapters";
import type { AttachmentAdapter } from "@assistant-ui/react";

const mockToastError = jest.fn();
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

jest.mock("@/lib/client-logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { useChatAttachments } from "@/lib/attachments/use-chat-attachments";
import { UploadClassifiedError } from "@/lib/errors/upload-errors";

let lastCallbacks: AttachmentProcessingCallbacks | undefined;
let lastOptions: ChatAttachmentAdapterOptions | undefined;
const factory = jest.fn(
  (callbacks: AttachmentProcessingCallbacks, options: ChatAttachmentAdapterOptions) => {
    lastCallbacks = callbacks;
    lastOptions = options;
    return { accept: "*" } as unknown as AttachmentAdapter;
  }
);

beforeEach(() => {
  factory.mockClear();
  mockToastError.mockClear();
  lastCallbacks = undefined;
  lastOptions = undefined;
});

describe("useChatAttachments", () => {
  it("builds the adapter once, repository-backed, and keeps it stable across renders", () => {
    const { result, rerender } = renderHook(() => useChatAttachments(factory));
    const first = result.current.attachmentAdapter;
    rerender();
    expect(result.current.attachmentAdapter).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(lastOptions?.repositoryBacked).toBe(true);
    expect(lastOptions?.purpose).toBeUndefined();
  });

  it("attributes uploads to the calling surface", () => {
    renderHook(() => useChatAttachments(factory, { purpose: "assistant-architect" }));
    expect(lastOptions?.purpose).toBe("assistant-architect");
  });

  it("marks a failed upload so its chip never reads Ready", () => {
    const { result } = renderHook(() => useChatAttachments(factory));

    // HybridDocumentAdapter reports onError, then still resolves -> complete.
    act(() => lastCallbacks?.onProcessingStart?.("a1"));
    act(() => {
      lastCallbacks?.onError?.("a1", new Error("boom"));
      lastCallbacks?.onProcessingComplete?.("a1");
    });

    expect(result.current.failedAttachments.has("a1")).toBe(true);
    expect(result.current.processingAttachments.has("a1")).toBe(false);
  });

  it("reads the conversation id lazily without recreating the adapter", () => {
    const { result } = renderHook(() =>
      useChatAttachments(factory, { initialConversationId: "initial-id" })
    );
    expect(lastOptions?.getConversationId?.()).toBe("initial-id");

    act(() => result.current.conversationId.set("next-id"));

    expect(lastOptions?.getConversationId?.()).toBe("next-id");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("tracks attachments while they process", () => {
    const { result } = renderHook(() => useChatAttachments(factory));

    act(() => lastCallbacks?.onProcessingStart?.("a1"));
    expect(result.current.processingAttachments.has("a1")).toBe(true);

    act(() => lastCallbacks?.onProcessingComplete?.("a1"));
    expect(result.current.processingAttachments.has("a1")).toBe(false);
  });

  it("offers a sign-in action when the upload fails on an expired session", () => {
    renderHook(() => useChatAttachments(factory));

    act(() => lastCallbacks?.onError?.(
      "a1",
      new UploadClassifiedError("UNAUTHORIZED", "Session expired", 401)
    ));

    expect(mockToastError).toHaveBeenCalledWith(
      "Session expired",
      expect.objectContaining({ action: expect.objectContaining({ label: "Sign in" }) })
    );
  });

  it("names the classified error code for other upload failures", () => {
    renderHook(() => useChatAttachments(factory));

    act(() => lastCallbacks?.onError?.(
      "a1",
      new UploadClassifiedError("FILE_TOO_LARGE", "Too large", 413)
    ));

    expect(mockToastError).toHaveBeenCalledWith(
      "File upload failed",
      expect.objectContaining({ description: "Upload error: file too large." })
    );
  });
});
