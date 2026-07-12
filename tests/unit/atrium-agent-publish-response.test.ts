/**
 * Unit coverage for the agent-bridge publish/unpublish error → HTTP mapping
 * (PR #1194 review: the route's error-mapping branch previously had no test
 * that runs in default CI — only the PLAYWRIGHT_AUTH_ENABLED-gated E2E).
 *
 * The mapping lives in `lib/content/agent-publish-response.ts` (lean module —
 * the route itself pulls the collab/TipTap ESM chain and is not jest-loadable).
 * Also pins `assertEditorDestination`, the 400 pre-check the route runs before
 * the service call (rejects `okf` and unknown destinations on agent surfaces).
 * Uses the GLOBAL jest per repo convention.
 */

import {
  mapAgentPublishError,
  AGENT_PUBLISH_APPROVAL_MESSAGE,
} from "@/lib/content/agent-publish-response";
import {
  ApprovalRequiredError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/content/errors";
import { assertEditorDestination } from "@/lib/content/validators";

describe("mapAgentPublishError", () => {
  it("maps ApprovalRequiredError to an honest 202 queued-for-approval body", () => {
    const mapped = mapAgentPublishError(
      new ApprovalRequiredError("needs approval"),
      "publish",
      "public_web"
    );
    expect(mapped).toEqual({
      status: 202,
      body: {
        applied: false,
        op: "publish",
        destination: "public_web",
        approvalRequired: true,
        message: AGENT_PUBLISH_APPROVAL_MESSAGE,
      },
    });
  });

  it("maps ApprovalRequiredError for unpublish with the op echoed", () => {
    const mapped = mapAgentPublishError(
      new ApprovalRequiredError("needs approval"),
      "unpublish",
      "public_web"
    );
    expect(mapped?.status).toBe(202);
    expect(mapped?.body.op).toBe("unpublish");
    expect(mapped?.body.applied).toBe(false);
  });

  it("maps NotFoundError to a masked 404 (no detail leak)", () => {
    const mapped = mapAgentPublishError(new NotFoundError("obj xyz missing"), "publish", "intranet");
    expect(mapped).toEqual({ status: 404, body: { error: "Not found" } });
  });

  it("maps ForbiddenError to a masked 403 (no detail leak)", () => {
    const mapped = mapAgentPublishError(new ForbiddenError("user 7 lacks edit"), "publish", "intranet");
    expect(mapped).toEqual({ status: 403, body: { error: "Forbidden" } });
  });

  it("maps ValidationError to 400 with the validator's message", () => {
    const mapped = mapAgentPublishError(
      new ValidationError("Invalid publish destination: okf"),
      "publish",
      "okf"
    );
    expect(mapped).toEqual({
      status: 400,
      body: { error: "Invalid publish destination: okf" },
    });
  });

  it("returns null for unknown errors so the caller rethrows to a 500", () => {
    expect(mapAgentPublishError(new Error("boom"), "publish", "intranet")).toBeNull();
    expect(mapAgentPublishError("string-throw", "unpublish", "intranet")).toBeNull();
  });
});

describe("assertEditorDestination (the route's 400 pre-check)", () => {
  it("accepts intranet and public_web", () => {
    expect(assertEditorDestination("intranet", "publish")).toBe("intranet");
    expect(assertEditorDestination("public_web", "unpublish")).toBe("public_web");
  });

  it("rejects okf (service-only destination) with a ValidationError the mapper turns into 400", () => {
    let caught: unknown;
    try {
      assertEditorDestination("okf", "publish");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const mapped = mapAgentPublishError(caught, "publish", "okf");
    expect(mapped?.status).toBe(400);
  });

  it("rejects unknown destinations and names the action in the message", () => {
    expect(() => assertEditorDestination("myspace", "unpublish")).toThrow(
      /Invalid unpublish destination: myspace/
    );
  });
});
