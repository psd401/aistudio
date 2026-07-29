const listMock = jest.fn();
const requesterMock = jest.fn();
const handleErrorMock = jest.fn();

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "request-list-since",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (value: unknown) => value,
}));

jest.mock("@/lib/error-utils", () => ({
  createSuccess: (data: unknown, message: string) => ({
    isSuccess: true,
    data,
    message,
  }),
  handleError: (...args: unknown[]) => handleErrorMock(...args),
}));

jest.mock("@/lib/content", () => ({
  contentService: {
    list: (...args: unknown[]) => listMock(...args),
  },
}));

jest.mock("@/actions/db/atrium/requester", () => ({
  getOptionalRequester: (...args: unknown[]) => requesterMock(...args),
}));

import { listContentAction } from "@/actions/db/atrium/list-content";

const REQUESTER = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  requesterMock.mockResolvedValue(REQUESTER);
  listMock.mockResolvedValue([]);
  handleErrorMock.mockReturnValue({
    isSuccess: false,
    message: "Failed to list content",
  });
});

describe("listContentAction since validation", () => {
  it("passes a valid ISO 8601 lower bound through to the service", async () => {
    const since = "2026-07-27T12:34:56.789Z";

    const result = await listContentAction({ since });

    expect(result.isSuccess).toBe(true);
    expect(listMock).toHaveBeenCalledWith(REQUESTER, { since });
  });

  it("rejects an invalid since before resolving the requester or listing", async () => {
    const result = await listContentAction({ since: "not-a-timestamp" });

    expect(result.isSuccess).toBe(false);
    expect(requesterMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(handleErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      "Failed to list content",
      expect.objectContaining({ operation: "listContentAction" })
    );
  });
});
