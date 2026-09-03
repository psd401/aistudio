/**
 * `codeEncoding: "base64"` decode on the in-app create-content server action
 * (#1714).
 *
 * WHY THIS EXISTS
 * ---------------
 * The library's "New artifact" flow seeds every new artifact with
 * `ARTIFACT_STARTER_HTML`, which contains a `<style>` block. Posted raw, the
 * ALB WAF's `CrossSiteScripting_BODY` rule blocks the server-action request
 * with a bare 403 that never reaches the app — so artifact creation from the
 * library was broken on every deployed environment while passing locally (no
 * WAF in front of the test harness). The transit fix is the same one the REST
 * routes, MCP tools and `createVersionAction` already use: send base64, decode
 * at the action boundary.
 *
 * What is asserted here is the ACTION contract:
 *   - a base64 body is DECODED before `contentService.create` is called, so the
 *     service (and its §28.3 guardrails/PII screening + size caps, which read
 *     `input.body`) always sees real content, never the inert wrapper,
 *   - an invalid base64 body fails the action and the service is NEVER called,
 *   - omitting `codeEncoding` passes the raw body through unchanged, and a
 *     bodyless create still reaches the service with `body: undefined` (the
 *     "no v1 snapshot" branch must not regress).
 *
 * `decodeContentBody` itself is NOT mocked — the point is the wiring, so its
 * real validation runs.
 */

const getUserRequesterMock = jest.fn();
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...a: unknown[]) => getUserRequesterMock(...a),
}));

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "cognito-sub" })),
}));

jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: jest.fn(async () => true),
}));

const notifyPublicExposureMock = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("@/lib/atrium/public-publish-policy", () => ({
  IN_APP_PUBLISH_PUBLIC_CAPABILITY: true,
  notifyPublicExposure: (...a: unknown[]) => notifyPublicExposureMock(...a),
}));

const createMock = jest.fn(async (..._a: unknown[]) => ({
  id: "obj-new",
  kind: "artifact",
  visibilityLevel: "private",
  version: { id: "ver-1" },
}));
jest.mock("@/lib/content", () => ({
  contentService: { create: (...a: unknown[]) => createMock(...a) },
}));

import { createContentAction } from "@/actions/db/atrium/create-content";
import { ARTIFACT_STARTER_HTML } from "@/lib/content/artifact-starter";
import type { Requester } from "@/lib/content/types";

const AUTHOR = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
} as unknown as Requester;

type CreateInput = Parameters<typeof createContentAction>[0];

/** The `input` object the action handed `contentService.create`. */
function serviceInput(): { body?: string; title?: string } {
  return createMock.mock.calls[0][1] as { body?: string; title?: string };
}

beforeEach(() => {
  jest.clearAllMocks();
  getUserRequesterMock.mockResolvedValue(AUTHOR);
});

describe("createContentAction — codeEncoding decode (#1714)", () => {
  it("decodes a base64 artifact body before contentService.create", async () => {
    const encoded = Buffer.from(ARTIFACT_STARTER_HTML, "utf8").toString(
      "base64"
    );

    const result = await createContentAction(
      {
        kind: "artifact",
        title: "Untitled page",
        body: encoded,
        bodyFormat: "html",
      } as CreateInput,
      { codeEncoding: "base64" }
    );

    expect(result.isSuccess).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
    // The service sees the REAL markup — including the <style> block that is
    // exactly what the WAF blocks in transit.
    expect(serviceInput().body).toBe(ARTIFACT_STARTER_HTML);
    expect(serviceInput().body).toContain("<style>");
  });

  it("round-trips a multi-byte (non-Latin-1) body", async () => {
    const source = "<style>/* café — 世界 🎉 */</style>";
    const encoded = Buffer.from(source, "utf8").toString("base64");

    const result = await createContentAction(
      {
        kind: "artifact",
        title: "Unicode",
        body: encoded,
        bodyFormat: "html",
      } as CreateInput,
      { codeEncoding: "base64" }
    );

    expect(result.isSuccess).toBe(true);
    expect(serviceInput().body).toBe(source);
  });

  it("rejects an invalid base64 body and never calls the service", async () => {
    const result = await createContentAction(
      {
        kind: "artifact",
        title: "Bad",
        body: "<style>not base64</style>",
        bodyFormat: "html",
      } as CreateInput,
      { codeEncoding: "base64" }
    );

    expect(result.isSuccess).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects codeEncoding with no body and never calls the service", async () => {
    const result = await createContentAction(
      { kind: "artifact", title: "Headless" } as CreateInput,
      { codeEncoding: "base64" }
    );

    expect(result.isSuccess).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("passes a raw body straight through when codeEncoding is omitted", async () => {
    const result = await createContentAction({
      kind: "document",
      title: "Doc",
      body: "# Hello",
      bodyFormat: "markdown",
    } as CreateInput);

    expect(result.isSuccess).toBe(true);
    expect(serviceInput().body).toBe("# Hello");
  });

  it("keeps a bodyless create bodyless (no v1 snapshot branch is unaffected)", async () => {
    const result = await createContentAction({
      kind: "document",
      title: "Untitled",
    } as CreateInput);

    expect(result.isSuccess).toBe(true);
    expect(serviceInput().body).toBeUndefined();
    expect(serviceInput().title).toBe("Untitled");
  });
});
