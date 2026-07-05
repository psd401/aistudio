/**
 * Component smoke for the §26.4 ApprovalsQueue (Epic #1059 completion).
 *
 * The approvals queue is the UI for a SECURITY-SENSITIVE decision (widening
 * content to a public destination), so its interactive contract is worth pinning
 * beyond the server-action unit tests:
 *  - renders each pending request with Approve / Deny controls;
 *  - Approve calls the action and, on success, optimistically removes the row;
 *  - a replay FAILURE keeps the row visible and surfaces the error (matches the
 *    server-side claim-then-revert semantics — a failed approve stays actionable);
 *  - Deny requires a non-empty note: "Confirm deny" is disabled until one is typed.
 *
 * The two server actions are mocked; the real shadcn UI primitives render in jsdom.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApprovalsQueue } from "@/components/atrium/admin/approvals-queue";
import type { PendingApprovalDTO } from "@/actions/db/atrium/approvals";

const approveMock = jest.fn();
const denyMock = jest.fn();
jest.mock("@/actions/db/atrium/approvals", () => ({
  approvePublishRequestAction: (...a: unknown[]) => approveMock(...a),
  denyPublishRequestAction: (...a: unknown[]) => denyMock(...a),
  listPendingApprovalsAction: jest.fn(),
}));

function row(over: Partial<PendingApprovalDTO> = {}): PendingApprovalDTO {
  return {
    id: "req-1",
    objectId: "obj-1",
    objectTitle: "Fractions Unit",
    objectSlug: "fractions-unit",
    requestKind: "publish",
    destination: "public_web",
    context: { destination: "public_web", slug: "fractions-unit" },
    requesterLabel: null,
    requestedByUserId: 42,
    requesterEmail: "teacher@psd401.net",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  approveMock.mockReset();
  denyMock.mockReset();
});

describe("ApprovalsQueue", () => {
  it("renders each pending request with Approve/Deny controls", () => {
    render(<ApprovalsQueue initialRequests={[row()]} initialError={null} />);
    expect(screen.getByText("Fractions Unit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("shows the empty state when there are no pending requests", () => {
    render(<ApprovalsQueue initialRequests={[]} initialError={null} />);
    expect(screen.getByText("No pending requests.")).toBeInTheDocument();
  });

  it("approves a request and optimistically removes the row on success", async () => {
    approveMock.mockResolvedValue({ isSuccess: true, message: "Request approved" });
    render(<ApprovalsQueue initialRequests={[row()]} initialError={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(approveMock).toHaveBeenCalledWith("req-1")
    );
    // The row is gone; the empty state + success notice replace it.
    await waitFor(() =>
      expect(screen.queryByText("Fractions Unit")).not.toBeInTheDocument()
    );
    expect(screen.getByRole("status")).toHaveTextContent("Request approved");
  });

  it("keeps the row and surfaces the error when the replay fails", async () => {
    approveMock.mockResolvedValue({
      isSuccess: false,
      message: "Schoology publishing is not yet available",
    });
    render(<ApprovalsQueue initialRequests={[row()]} initialError={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Schoology publishing is not yet available"
      )
    );
    // The request is still present — a failed approve stays actionable.
    expect(screen.getByText("Fractions Unit")).toBeInTheDocument();
  });

  it("requires a non-empty note before Confirm deny is enabled", async () => {
    denyMock.mockResolvedValue({ isSuccess: true, message: "Request denied" });
    render(<ApprovalsQueue initialRequests={[row()]} initialError={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    const confirm = screen.getByRole("button", { name: "Confirm deny" });
    // Guard: disabled with no reason, so a denial can never be recorded empty.
    expect(confirm).toBeDisabled();
    expect(denyMock).not.toHaveBeenCalled();

    fireEvent.change(
      screen.getByPlaceholderText("Reason for denial (required)"),
      { target: { value: "Contains student PII" } }
    );
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(denyMock).toHaveBeenCalledWith("req-1", "Contains student PII")
    );
  });
});
