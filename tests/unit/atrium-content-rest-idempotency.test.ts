/** @jest-environment node */

const mockCreateErrorResponse = jest.fn();

jest.mock("@/lib/api/auth-middleware", () => ({
  createApiResponse: jest.fn(),
  createErrorResponse: (...args: unknown[]) =>
    mockCreateErrorResponse(...args),
}));
jest.mock("@/lib/content/audit", () => ({
  recordContentAudit: jest.fn(),
}));
jest.mock("@/lib/content/requester-from-auth", () => ({
  requesterFromApiAuth: jest.fn(),
}));

import { ValidationError, StorageError } from "@/lib/content/errors";
import { contentIdempotentMutationErrorToResponse } from "@/lib/content/rest";

describe("idempotent Atrium REST error mapping", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateErrorResponse.mockReturnValue({ status: 400 });
  });

  it("returns deterministic client failures for encrypted replay", () => {
    const error = new ValidationError("Invalid content");

    const response = contentIdempotentMutationErrorToResponse(
      error,
      "request-1"
    );

    expect(response).toEqual({ status: 400 });
    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "request-1",
      400,
      "CONTENT_VALIDATION",
      "Invalid content",
      undefined
    );
  });

  it("rethrows storage failures because commit state may be ambiguous", () => {
    const error = new StorageError();

    expect(() =>
      contentIdempotentMutationErrorToResponse(error, "request-2")
    ).toThrow(error);
    expect(mockCreateErrorResponse).not.toHaveBeenCalled();
  });

  it("rethrows unknown server failures instead of releasing the reservation", () => {
    const error = new Error("post-commit failure");

    expect(() =>
      contentIdempotentMutationErrorToResponse(error, "request-3")
    ).toThrow(error);
    expect(mockCreateErrorResponse).not.toHaveBeenCalled();
  });
});
