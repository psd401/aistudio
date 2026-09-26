import { test, expect, type Page } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

/**
 * E2E for #1840: while an EDITABLE artifact is bound to the turn, the Nexus model
 * router must not run a short follow-up on the light tier.
 *
 * Why this exists on top of the unit suite: the router unit tests
 * (`lib/nexus/model-router/__tests__/router.test.ts`) hand `routeNexusRequest` a
 * workspace object directly. They prove the DECISION but say nothing about the
 * chain that produces its input — the browser putting `workspaceId` on the chat
 * request, and the route resolving it into `{ kind, editable }` before routing. A
 * regression anywhere in that chain leaves production turns on the light tier with
 * every unit test still green, which is exactly the shape of the bug #1840 reports.
 *
 * What is asserted, against the real authenticated route:
 *  (a) WIRING — the composer on `/nexus?workspace=<slug>` puts a `workspaceId` on
 *      the outbound chat request for a three-word follow-up. Captured at the
 *      transport with a mocked response, so it costs no provider tokens.
 *  (b) ARTIFACT — replaying that captured body for real comes back routed at
 *      `medium` or `high`, never `light`, and still carries a #1786 PSD Data
 *      reason code so the floor did not displace the connector attach.
 *  (c) DOCUMENT — the same message with a document bound carries none of the
 *      artifact reason codes, so the rule did not widen past the predicate.
 *  (d) AUTH GATE — the chat route refuses an unauthenticated caller.
 *
 * The routing decision is read from the `X-Nexus-Routing` response header, which
 * the route emits for exactly this purpose. Read from the HEADERS, not the body:
 * routing is settled before the stream opens, so the assertion needs no model
 * output, and the probe cancels the stream immediately.
 *
 * The replay uses the body the REAL composer just sent (notably its `modelId`,
 * which `ChatRequestSchema` requires) rather than a hand-written payload, so the
 * spec cannot drift from the client contract and silently start asserting against
 * a 400.
 *
 * Deliberately NOT asserting the `workspace_artifact_min_tier` reason code. The
 * classifier is live here and may rate "did that work?" as `medium` on its own, in
 * which case there was nothing to raise and the code is correctly absent.
 * `tier !== "light"` is the acceptance criterion either way, and it holds however
 * the classifier votes. The code's presence is pinned in the unit suite, where the
 * classifier is a mock.
 *
 * PREREQUISITES for the gated tests (they are NOT run in CI):
 *  - Host dev server with PLAYWRIGHT_AUTH_ENABLED=true (`bun run test:e2e:local`;
 *    see docs/guides/e2e-authenticated-testing.md).
 *  - Seed: tests/e2e/fixtures/atrium-meridian-artifact-seed.sql — an admin-owned
 *    artifact AND an admin-owned document, so `editable` is true for both and
 *    `kind` is the only difference. Same fixture as the #1786 spec.
 *  - NEXUS_ROUTER_MODE=active, which the local settings seed carries. Under
 *    `shadow` or `off` the router records no tier of its own, so the artifact test
 *    skips rather than failing on a mode that is not this change's behaviour.
 */

const ARTIFACT_SLUG =
  process.env.ATRIUM_MERIDIAN_ARTIFACT_SLUG ?? "atrium-meridian-artifact";
const DOCUMENT_SLUG =
  process.env.ATRIUM_MERIDIAN_DOC_SLUG ?? "atrium-meridian-embed-doc";

/** The exact reproduction from the issue: a follow-up with no data words in it. */
const SHORT_FOLLOW_UP = "Did that work?";

/** Enough of the client contract to replay the turn for real. */
interface CapturedChatBody {
  messages: Array<Record<string, unknown>>;
  modelId: string;
  nexusMode?: string;
  modelFamily?: string;
  workspaceId?: string;
}

interface RoutingMetadata {
  tier?: string;
  runtimeMode?: string;
  reasonCodes?: string[];
}

const MOCK_CHAT_STREAM = [
  'data: {"type":"start","messageId":"e2e-tier-floor-assistant"}\n\n',
  'data: {"type":"text-start","id":"e2e-tier-floor-text"}\n\n',
  'data: {"type":"text-delta","id":"e2e-tier-floor-text","delta":"ok"}\n\n',
  'data: {"type":"text-end","id":"e2e-tier-floor-text"}\n\n',
  'data: {"type":"finish","finishReason":"stop"}\n\n',
  "data: [DONE]\n\n",
].join("");

/**
 * Open Nexus with a workspace object bound and capture the body the composer
 * sends for one short follow-up, answering it with a mocked stream.
 *
 * The mock is what keeps this half deterministic: it asserts browser state →
 * transport wiring without depending on any provider being reachable.
 */
async function captureWorkspaceTurn(
  page: Page,
  workspaceSlug: string,
): Promise<CapturedChatBody> {
  await page.goto(`/nexus?workspace=${workspaceSlug}`);
  await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 60_000 });

  let resolveBody: (body: CapturedChatBody) => void = () => undefined;
  const captured = new Promise<CapturedChatBody>(resolve => {
    resolveBody = resolve;
  });

  await page.route(
    "**/api/nexus/chat",
    async route => {
      const body = route.request().postDataJSON() as CapturedChatBody;
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
        },
        body: MOCK_CHAT_STREAM,
      });
      resolveBody(body);
    },
    { times: 1 },
  );

  await page.locator('[aria-label="Message input"]').fill(SHORT_FOLLOW_UP);
  await page.locator('[aria-label="Send message"]').click();
  const body = await captured;
  // Stop intercepting so the replay below reaches the real route.
  await page.unroute("**/api/nexus/chat");
  return body;
}

/**
 * Replay a captured body against the real route and return its routing metadata.
 *
 * `conversationId` is dropped so the replay starts its own conversation instead of
 * appending a second user turn to the one the mocked send just created.
 */
async function probeRouting(
  page: Page,
  body: CapturedChatBody,
): Promise<{ status: number; routing: RoutingMetadata | null }> {
  return page.evaluate(async captured => {
    const { conversationId: _drop, ...payload } = captured as Record<string, unknown>;
    const response = await fetch("/api/nexus/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // The headers are all this spec needs; leaving the body open would keep a
    // model generating for nothing.
    await response.body?.cancel().catch(() => undefined);
    const header = response.headers.get("X-Nexus-Routing");
    return {
      status: response.status,
      routing: header
        ? (JSON.parse(decodeURIComponent(header)) as RoutingMetadata)
        : null,
    };
  }, body as unknown as Record<string, unknown>);
}

test.describe("#1840 the artifact tier floor reaches the real chat route", () => {
  test.describe.configure({ timeout: 180_000 });
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Authenticated functional tier — needs a host dev server and AUTH_SECRET",
  );

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
  });

  test("a short follow-up with an editable artifact bound never routes light", async ({
    page,
  }) => {
    const body = await captureWorkspaceTurn(page, ARTIFACT_SLUG);

    // (a) The wiring half — deterministic, and the part a refactor would silently
    // break while every router unit test stayed green.
    expect(body.workspaceId, "composer must send the bound workspace id").toBeTruthy();
    expect(body.modelId.length).toBeGreaterThan(0);

    // (b) The routing half, against the real route.
    const probe = await probeRouting(page, body);
    expect(
      probe.routing,
      `no X-Nexus-Routing header on the replay (status ${probe.status})`,
    ).not.toBeNull();
    if (!probe.routing) return;
    test.skip(
      probe.routing.runtimeMode !== "active",
      `Router runtime mode is "${probe.routing.runtimeMode}"; the floor only governs active routing`,
    );

    expect(probe.routing.tier).not.toBe("light");
    expect(["medium", "high"]).toContain(probe.routing.tier);
    // #1786 must still hold on the same turn: the floor did not displace the
    // connector attach. Either code proves the workspace was seen as an artifact;
    // which one depends on whether this deployment has the connector configured.
    expect(probe.routing.reasonCodes ?? []).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^workspace_(artifact_psd_data|psd_data_unavailable)$/),
      ]),
    );
  });

  test("the same follow-up with a document bound carries no artifact reason codes", async ({
    page,
  }) => {
    const body = await captureWorkspaceTurn(page, DOCUMENT_SLUG);
    expect(body.workspaceId, "composer must send the bound workspace id").toBeTruthy();

    const probe = await probeRouting(page, body);
    expect(
      probe.routing,
      `no X-Nexus-Routing header on the replay (status ${probe.status})`,
    ).not.toBeNull();
    if (!probe.routing) return;

    const reasonCodes = probe.routing.reasonCodes ?? [];
    expect(reasonCodes).not.toContain("workspace_artifact_min_tier");
    expect(reasonCodes).not.toContain("workspace_artifact_min_tier_unmet");
    expect(reasonCodes).not.toContain("workspace_artifact_psd_data");
  });
});

/**
 * Unauthenticated: the floor is server-side routing behind a session, so the gate
 * is part of the contract. Needs no seed and no provider.
 */
test.describe("#1840 auth gate", () => {
  test("the chat route refuses an unauthenticated workspace turn", async ({ request }) => {
    const response = await request.post("/api/nexus/chat", {
      data: {
        messages: [
          {
            id: "e2e-tier-floor-guard",
            role: "user",
            parts: [{ type: "text", text: SHORT_FOLLOW_UP }],
          },
        ],
        modelId: "gpt-4o-mini",
        nexusMode: "standard",
        modelFamily: "auto",
        workspaceId: ARTIFACT_SLUG,
      },
    });

    expect(response.status()).toBe(401);
    expect(response.headers()["x-nexus-routing"]).toBeUndefined();
  });
});
