import { test, expect, type Page } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { gotoNexus } from "./nexus/utils";

const ADMIN_EMAIL = "test@example.com";
const ADMIN_SUB = "e2e-test-user";
const READER_EMAIL = "repository-reader@example.com";
const READER_SUB = "e2e-repository-reader";
const STAFF_EMAIL = "staff@example.com";
const STAFF_SUB = "e2e-staff-user";
const STUDENT_EMAIL = "student@example.com";
const STUDENT_SUB = "e2e-student-user";

const SHARED_REPOSITORY = "E2E Unified Content Repository";
const OWNER_ONLY_REPOSITORY = "E2E Owner Only Repository";

const AA_BINDING_ID = "33333333-4444-4555-8666-777777777777";
const NEXUS_BINDING_ID = "44444444-5555-4666-8777-888888888888";
const IMAGE_BINDING_ID = "55555555-6666-4777-8888-999999999999";

const MOCK_STREAM = [
  'data: {"type":"start","messageId":"e2e-unified-content-assistant"}\n\n',
  'data: {"type":"text-start","id":"e2e-unified-content-text"}\n\n',
  'data: {"type":"text-delta","id":"e2e-unified-content-text","delta":"ok"}\n\n',
  'data: {"type":"text-end","id":"e2e-unified-content-text"}\n\n',
  'data: {"type":"finish","finishReason":"stop"}\n\n',
  "data: [DONE]\n\n",
].join("");

type NexusCanonicalRouteState = {
  uploadBodies: string[];
  chatBodies: Array<Record<string, unknown>>;
  promotionBodies: Array<Record<string, unknown>>;
  legacyUploadCount: number;
};

async function configureNexusCanonicalRoutes(
  page: Page,
  state: NexusCanonicalRouteState,
  uploadSessionId: string
): Promise<void> {
  await page.route(
    "**/api/repositories/temporary-attachments",
    async (route) => {
      state.uploadBodies.push(
        route.request().postDataBuffer()?.toString("utf8") ?? ""
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "canonical",
          bindingId: NEXUS_BINDING_ID,
          repositoryId: 8800,
          upload: {
            sessionId: uploadSessionId,
            uploadMethod: "single",
            uploadUrl: "/__e2e-storage/nexus-canonical",
          },
        }),
      });
    }
  );
  await page.route("**/__e2e-storage/nexus-canonical", async (route) => {
    expect(route.request().method()).toBe("PUT");
    await route.fulfill({ status: 200 });
  });
  await page.route(
    `**/api/repositories/temporary-attachments/${NEXUS_BINDING_ID}/complete`,
    async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        sessionId: uploadSessionId,
        name: "nexus-canonical.pdf",
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "canonical",
          reference: {
            bindingId: NEXUS_BINDING_ID,
            itemId: 8801,
            name: "nexus-canonical.pdf",
          },
          repositoryId: 8800,
          itemVersionId: "88888888-9999-4aaa-8bbb-cccccccccccc",
          processingJobId: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
        }),
      });
    }
  );
  await page.route(
    `**/api/repositories/temporary-attachments/${NEXUS_BINDING_ID}/8801`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "embedded", error: null }),
      });
    }
  );
  await page.route("**/api/documents/v2/upload", async (route) => {
    state.legacyUploadCount += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Legacy upload must not run" }),
    });
  });
  await page.route("**/api/nexus/chat", async (route) => {
    state.chatBodies.push(
      route.request().postDataJSON() as Record<string, unknown>
    );
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
        "X-Conversation-Id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      },
      body: MOCK_STREAM,
    });
  });
  await page.route(
    `**/api/repositories/temporary-attachments/${NEXUS_BINDING_ID}/8801/promote`,
    async (route) => {
      state.promotionBodies.push(
        route.request().postDataJSON() as Record<string, unknown>
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          repositoryId: 8800,
          name: "nexus-canonical",
        }),
      });
    }
  );
}

async function openRepository(
  page: Page,
  repositoryName = SHARED_REPOSITORY,
): Promise<void> {
  await page.goto("/repositories");
  const row = page.getByRole("row").filter({ hasText: repositoryName });
  await expect(row).toBeVisible();
  await row.getByRole("button").first().click();
  await expect(
    page.getByRole("heading", { name: repositoryName }),
  ).toBeVisible();
}

async function addNexusAttachment(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
}

const defineUnifiedContentPlatformGuardsSuite1 = () => {
  test("temporary attachment and promotion APIs reject unauthenticated callers", async ({
    request,
  }) => {
    const upload = await request.post(
      "/api/repositories/temporary-attachments",
      {
        data: {
          draftKey: "55555555-6666-4777-8888-999999999999",
          purpose: "nexus",
          fileName: "guard.txt",
          contentType: "text/plain",
          byteSize: 5,
        },
      },
    );
    expect(upload.status()).toBe(401);

    const status = await request.get(
      `/api/repositories/temporary-attachments/${NEXUS_BINDING_ID}/8801`,
    );
    expect(status.status()).toBe(401);

    const promotion = await request.post(
      `/api/repositories/temporary-attachments/${NEXUS_BINDING_ID}/8801/promote`,
      { data: { name: "Unauthorized promotion" } },
    );
    expect(promotion.status()).toBe(401);

    const googleConnectors = await request.get(
      "/api/repositories/1/connectors/google",
    );
    expect(googleConnectors.status()).toBe(401);

    const googleAuthorize = await request.get(
      "/api/repositories/1/connectors/google/authorize",
    );
    expect(googleAuthorize.status()).toBe(401);

    const malformedGoogleNotification = await request.post(
      "/api/repositories/connectors/google/webhook",
    );
    expect(malformedGoogleNotification.status()).toBe(400);
    await expect(malformedGoogleNotification.json()).resolves.toEqual({
      error: "Invalid notification",
    });
  });
};

test.describe("Unified content platform guards", defineUnifiedContentPlatformGuardsSuite1);

const defineUnifiedContentProductMigrationAuthenticatedSuite2Registration1: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }) => {
    await authenticateContext(page.context(), READER_EMAIL, READER_SUB);
    await page.goto("/repositories");

    const sharedRow = page
      .getByRole("row")
      .filter({ hasText: SHARED_REPOSITORY });
    await expect(sharedRow).toBeVisible();
    await expect(sharedRow).toContainText("Shared read only");
    await expect(
      page.getByText(OWNER_ONLY_REPOSITORY, { exact: true }),
    ).toHaveCount(0);

    await sharedRow.getByRole("button").first().click();
    await expect(
      page.getByRole("heading", { name: SHARED_REPOSITORY }),
    ).toBeVisible();
    await expect(
      page.getByText("Shared read only", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add Item" })).toHaveCount(0);

    await page.getByRole("tab", { name: "Access Control" }).click();
    await expect(
      page.getByText(
        "You can read and search this repository, but only its owner or an administrator can change content, settings, or access.",
      ),
    ).toBeVisible();

    await page.getByRole("tab", { name: "Items" }).click();
    await page
      .getByRole("button", {
        name: "View details for E2E failed processing fixture",
      })
      .click();
    const details = page.getByRole("dialog", {
      name: "Repository item details",
    });
    await expect(details).toBeVisible();
    await expect(
      details.getByText("Version 1", { exact: true }).first(),
    ).toBeVisible();
    await expect(details.getByText("Current", { exact: true })).toBeVisible();
    await expect(details.getByRole("tab", { name: "Citations" })).toBeVisible();
  };
const defineUnifiedContentProductMigrationAuthenticatedSuite2Registration2: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }) => {
    await authenticateContext(page.context(), ADMIN_EMAIL, ADMIN_SUB);
    await page.route(
      /\/api\/repositories\/\d+\/connectors\/google$/,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            connectors: [],
          }),
        });
      },
    );
    await openRepository(page);

    await expect(page.getByText("durable", { exact: true })).toBeVisible();
    await expect(page.getByText("active", { exact: true })).toBeVisible();
    await expect(page.getByText("Persistent", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();

    await page.getByRole("button", { name: "Add Item" }).click();
    const sourceDialog = page.getByRole("dialog", {
      name: "Add Item to Repository",
    });
    await expect(sourceDialog).toBeVisible();
    await expect(sourceDialog.getByRole("tab", { name: "File" })).toBeVisible();
    await expect(sourceDialog.getByRole("tab", { name: "URL" })).toBeVisible();
    await expect(sourceDialog.getByRole("tab", { name: "Text" })).toBeVisible();
    await expect(
      sourceDialog.getByRole("tab", { name: "Google Drive" }),
    ).toBeVisible();
    await sourceDialog.getByRole("tab", { name: "Google Drive" }).click();
    await expect(
      sourceDialog.getByRole("heading", { name: "Google Drive" }),
    ).toBeVisible();
    await expect(
      sourceDialog.getByRole("button", { name: "Connect Google Drive" }),
    ).toBeVisible();
    await expect(
      sourceDialog.getByText(
        "Connect with read-only access, then choose files or folders from My Drive or Shared Drives that you can already access.",
      ),
    ).toBeVisible();
    await expect(sourceDialog.getByText(/unified-content-sync@/)).toHaveCount(
      0,
    );
  };
const defineUnifiedContentProductMigrationAuthenticatedSuite2Registration3: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }) => {
    await authenticateContext(page.context(), STAFF_EMAIL, STAFF_SUB);
    await page.goto("/repositories");

    await expect(
      page.getByRole("row").filter({ hasText: SHARED_REPOSITORY }),
    ).toBeVisible();
    await expect(
      page.getByText(OWNER_ONLY_REPOSITORY, { exact: true }),
    ).toHaveCount(0);

    await page.goto("/utilities/assistant-architect/9030/edit/prompts");
    await page.getByRole("button", { name: "Add Prompt" }).click();
    const promptDialog = page.getByRole("dialog", { name: "Add Prompt" });
    await promptDialog.getByLabel("Add external knowledge").click();
    await promptDialog
      .getByRole("button", { name: "Browse Repositories" })
      .click();

    const picker = page.getByRole("dialog", {
      name: "Choose knowledge repositories",
    });
    await picker.getByLabel("Search repositories").fill(SHARED_REPOSITORY);
    const sharedRepository = picker
      .getByRole("button")
      .filter({ hasText: SHARED_REPOSITORY });
    await expect(sharedRepository).toBeVisible();
    await sharedRepository.click();
    await expect(sharedRepository).toHaveAttribute("aria-pressed", "true");
  };
const defineUnifiedContentProductMigrationAuthenticatedSuite2Registration4: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }) => {
    await authenticateContext(page.context(), STUDENT_EMAIL, STUDENT_SUB);
    const response = await page.request.post(
      `/api/repositories/temporary-attachments/${NEXUS_BINDING_ID}/8801/promote`,
      { data: { name: "Forbidden promotion" } },
    );
    expect(response.status()).toBe(403);
  };
const defineUnifiedContentProductMigrationAuthenticatedSuite2Registration5: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }) => {
    await authenticateContext(page.context(), ADMIN_EMAIL, ADMIN_SUB);
    await page.goto("/utilities/assistant-architect/9010/edit/prompts");
    await page.getByRole("button", { name: "Add Prompt" }).click();

    const promptDialog = page.getByRole("dialog", { name: "Add Prompt" });
    await expect(promptDialog).toBeVisible();
    await promptDialog.getByLabel("Add external knowledge").click();
    await expect(
      promptDialog.getByRole("button", { name: "Upload Document" }),
    ).toHaveCount(0);
    await expect(
      promptDialog.getByText("Direct Knowledge Input", { exact: true }),
    ).toHaveCount(0);

    await promptDialog
      .getByRole("button", { name: "Browse Repositories" })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Choose knowledge repositories",
    });
    await expect(picker).toBeVisible();
    await picker.getByLabel("Search repositories").fill(SHARED_REPOSITORY);
    const repositoryOption = picker
      .getByRole("button")
      .filter({ hasText: SHARED_REPOSITORY });
    await repositoryOption.click();
    await expect(repositoryOption).toHaveAttribute("aria-pressed", "true");
    await picker.getByRole("button", { name: "Done" }).click();
    await expect(
      promptDialog.getByText("1 selected", { exact: true }),
    ).toBeVisible();

    await promptDialog
      .getByRole("button", { name: "Add repository content" })
      .click();
    const destinationPicker = page.getByRole("dialog", {
      name: "Choose a destination",
    });
    await expect(destinationPicker).toBeVisible();
    await destinationPicker
      .getByLabel("Search repositories")
      .fill(SHARED_REPOSITORY);
    await destinationPicker
      .getByRole("button")
      .filter({ hasText: SHARED_REPOSITORY })
      .click();

    const sourceDialog = page.getByRole("dialog", {
      name: "Add Item to Repository",
    });
    await expect(sourceDialog).toBeVisible();
    await expect(sourceDialog.getByRole("tab", { name: "File" })).toBeVisible();
    await expect(sourceDialog.getByRole("tab", { name: "Text" })).toBeVisible();
  };
const defineUnifiedContentProductMigrationAuthenticatedSuite2Registration6: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }) => {
    await authenticateContext(page.context(), ADMIN_EMAIL, ADMIN_SUB);

    const uploadBodies: string[] = [];
    const executions: Array<Record<string, unknown>> = [];
    let legacyUploadCount = 0;
    const uploadSessionId = "11111111-2222-4333-8444-555555555555";

    await page.route(
      "**/api/repositories/temporary-attachments",
      async (route) => {
        uploadBodies.push(
          route.request().postDataBuffer()?.toString("utf8") ?? "",
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            mode: "canonical",
            bindingId: AA_BINDING_ID,
            repositoryId: 7700,
            upload: {
              sessionId: uploadSessionId,
              uploadMethod: "single",
              uploadUrl: "/__e2e-storage/aa-private-source",
            },
          }),
        });
      },
    );
    await page.route("**/__e2e-storage/aa-private-source", async (route) => {
      expect(route.request().method()).toBe("PUT");
      await route.fulfill({ status: 200 });
    });
    await page.route(
      new RegExp(
        `/api/repositories/temporary-attachments/${AA_BINDING_ID}/complete$`,
      ),
      async (route) => {
        expect(route.request().postDataJSON()).toMatchObject({
          sessionId: uploadSessionId,
          name: "aa-private-source.pdf",
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            mode: "canonical",
            reference: {
              bindingId: AA_BINDING_ID,
              itemId: 7701,
              name: "aa-private-source.pdf",
            },
            repositoryId: 7700,
            itemVersionId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
            processingJobId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
          }),
        });
      },
    );
    await page.route(
      new RegExp(
        `/api/repositories/temporary-attachments/${AA_BINDING_ID}/7701$`,
      ),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "embedded", error: null }),
        });
      },
    );
    await page.route("**/api/documents/v2/upload", async (route) => {
      legacyUploadCount += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Legacy upload must not run" }),
      });
    });
    await page.route("**/api/assistant-architect/execute", async (route) => {
      executions.push(
        route.request().postDataJSON() as Record<string, unknown>,
      );
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Execution-Id": "99001",
          "X-Prompt-Count": "2",
          "X-Conversation-Id": "88888888-9999-4aaa-8bbb-cccccccccccc",
        },
        body: MOCK_STREAM,
      });
    });

    await page.goto("/tools/assistant-architect/9000");
    await page.getByLabel("Upload Document").setInputFiles({
      name: "aa-private-source.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(
        "%PDF-1.4\nAA-SOURCE-BYTES-MUST-NOT-REACH-THE-MODEL\n%%EOF",
      ),
    });

    const uploadButton = page.getByRole("button", {
      name: "Add Document for Knowledge",
    });
    await expect(uploadButton).toBeEnabled();
    await expect(uploadButton).toContainText("aa-private-source");
    await page.getByRole("button", { name: "Generate" }).click();
    await expect.poll(() => executions.length, { timeout: 30_000 }).toBe(1);

    expect(uploadBodies).toHaveLength(1);
    expect(JSON.parse(uploadBodies[0])).toMatchObject({
      purpose: "assistant-architect",
      fileName: "aa-private-source.pdf",
      contentType: "application/pdf",
    });
    expect(uploadBodies[0]).not.toContain(
      "AA-SOURCE-BYTES-MUST-NOT-REACH-THE-MODEL",
    );
    expect(legacyUploadCount).toBe(0);

    const inputs = executions[0]?.inputs as Record<string, unknown> | undefined;
    const documentInput = inputs?.e2e_knowledge_document;
    expect(typeof documentInput).toBe("string");
    expect(documentInput).toBe(
      `[[repository-attachment:v1:${AA_BINDING_ID}:7701:aa-private-source.pdf]]`,
    );
    expect(documentInput).not.toContain(
      "AA-SOURCE-BYTES-MUST-NOT-REACH-THE-MODEL",
    );
  };
const defineUnifiedContentProductMigrationAuthenticatedSuite2Registration7: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }) => {
    await authenticateContext(page.context(), ADMIN_EMAIL, ADMIN_SUB);

    const routeState: NexusCanonicalRouteState = {
      uploadBodies: [],
      chatBodies: [],
      promotionBodies: [],
      legacyUploadCount: 0,
    };
    const uploadSessionId = "22222222-3333-4444-8555-666666666666";
    await configureNexusCanonicalRoutes(page, routeState, uploadSessionId);

    await gotoNexus(page);
    await addNexusAttachment(page, {
      name: "nexus-canonical.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(
        "%PDF-1.4\nNEXUS-SOURCE-BYTES-MUST-NOT-REACH-THE-MODEL\n%%EOF",
      ),
    });
    await expect(
      page.getByText("nexus-canonical.pdf", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeEnabled();

    await page.getByLabel("Message input").fill("Use the attached policy.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(() => routeState.chatBodies.length, { timeout: 30_000 })
      .toBe(1);

    expect(routeState.uploadBodies).toHaveLength(1);
    expect(JSON.parse(routeState.uploadBodies[0])).toMatchObject({
      purpose: "nexus",
      fileName: "nexus-canonical.pdf",
      contentType: "application/pdf",
    });
    expect(routeState.uploadBodies[0]).not.toContain(
      "NEXUS-SOURCE-BYTES-MUST-NOT-REACH-THE-MODEL",
    );
    expect(routeState.legacyUploadCount).toBe(0);

    const serializedChat = JSON.stringify(routeState.chatBodies[0]);
    const opaqueMarker =
      `[[repository-attachment:v1:${NEXUS_BINDING_ID}:8801:` +
      "nexus-canonical.pdf]]";
    expect(serializedChat).toContain(opaqueMarker);
    expect(serializedChat).not.toContain(
      "NEXUS-SOURCE-BYTES-MUST-NOT-REACH-THE-MODEL",
    );
    await expect(page.getByText(opaqueMarker, { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Temporary repository attachment", { exact: true }),
    ).toBeVisible();

    const keepButton = page.getByRole("button", {
      name: "Keep as a repository",
    });
    await expect(keepButton).toBeVisible();
    await keepButton.click();
    await expect.poll(() => routeState.promotionBodies.length).toBe(1);
    expect(routeState.promotionBodies[0]).toEqual({
      name: "nexus-canonical",
    });
    await expect(
      page.getByRole("button", { name: "Saved as a repository" }),
    ).toBeVisible();
  };
const defineUnifiedContentProductMigrationAuthenticatedSuite2Registration8: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }) => {
    await authenticateContext(page.context(), ADMIN_EMAIL, ADMIN_SUB);

    const uploadBodies: string[] = [];
    const chatBodies: Array<Record<string, unknown>> = [];
    const uploadSessionId = "66666666-7777-4888-8999-aaaaaaaaaaaa";

    await page.route(
      "**/api/repositories/temporary-attachments",
      async (route) => {
        uploadBodies.push(
          route.request().postDataBuffer()?.toString("utf8") ?? "",
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            mode: "canonical",
            bindingId: IMAGE_BINDING_ID,
            repositoryId: 8900,
            upload: {
              sessionId: uploadSessionId,
              uploadMethod: "single",
              uploadUrl: "/__e2e-storage/nexus-image",
            },
          }),
        });
      },
    );
    await page.route("**/__e2e-storage/nexus-image", async (route) => {
      expect(route.request().method()).toBe("PUT");
      await route.fulfill({ status: 200 });
    });
    await page.route(
      new RegExp(
        `/api/repositories/temporary-attachments/${IMAGE_BINDING_ID}/complete$`,
      ),
      async (route) => {
        expect(route.request().postDataJSON()).toMatchObject({
          sessionId: uploadSessionId,
          name: "nexus-image.png",
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            mode: "canonical",
            reference: {
              bindingId: IMAGE_BINDING_ID,
              itemId: 8901,
              name: "nexus-image.png",
            },
            repositoryId: 8900,
            itemVersionId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
            processingJobId: "88888888-9999-4aaa-8bbb-cccccccccccc",
          }),
        });
      },
    );
    await page.route(
      new RegExp(
        `/api/repositories/temporary-attachments/${IMAGE_BINDING_ID}/8901$`,
      ),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "embedded", error: null }),
        });
      },
    );
    await page.route("**/api/nexus/chat", async (route) => {
      chatBodies.push(
        route.request().postDataJSON() as Record<string, unknown>,
      );
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "X-Conversation-Id": "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        },
        body: MOCK_STREAM,
      });
    });

    await gotoNexus(page);
    await addNexusAttachment(page, {
      name: "nexus-image.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect(
      page.getByText("nexus-image.png", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Message input").fill("Restyle this image.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => chatBodies.length, { timeout: 30_000 }).toBe(1);

    expect(JSON.parse(uploadBodies[0] ?? "{}")).toMatchObject({
      purpose: "nexus",
      fileName: "nexus-image.png",
      contentType: "image/png",
    });
    const serializedChat = JSON.stringify(chatBodies[0]);
    expect(serializedChat).toContain("data:image/png;base64,");
    expect(serializedChat).toContain(
      `[[repository-attachment:v1:${IMAGE_BINDING_ID}:8901:nexus-image.png]]`,
    );
    await expect(
      page.getByText("Temporary repository attachment", { exact: true }),
    ).toBeVisible();
  };
const defineUnifiedContentProductMigrationAuthenticatedSuite2Registration9: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }) => {
    await authenticateContext(page.context(), ADMIN_EMAIL, ADMIN_SUB);
    const uniquePrompt = "FORGED-ATTACHMENT-SHOULD-NOT-CREATE-CONVERSATION";
    const response = await page.request.post("/api/nexus/chat", {
      data: {
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [
              {
                type: "text",
                text:
                  `${uniquePrompt}\n` +
                  `[[repository-attachment:v1:${NEXUS_BINDING_ID}:999999:missing.pdf]]`,
              },
            ],
          },
        ],
        modelId: "preflight-does-not-reach-model-resolution",
      },
    });
    expect(response.status()).toBe(404);

    const conversationsResponse = await page.request.get(
      "/api/nexus/conversations?limit=500",
    );
    expect(conversationsResponse.ok()).toBe(true);
    const conversationsBody = (await conversationsResponse.json()) as {
      conversations: Array<{ title?: string | null }>;
    };
    expect(
      conversationsBody.conversations.some((conversation) =>
        conversation.title?.includes(uniquePrompt),
      ),
    ).toBe(false);
  };
const defineUnifiedContentProductMigrationAuthenticatedSuite2Registration10: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }) => {
    await authenticateContext(page.context(), ADMIN_EMAIL, ADMIN_SUB);

    let canonicalNegotiationCount = 0;
    let legacyUploadCount = 0;
    let legacyStatusCount = 0;

    await page.route(
      "**/api/repositories/temporary-attachments",
      async (route) => {
        canonicalNegotiationCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ mode: "legacy" }),
        });
      },
    );
    await page.route("**/api/documents/v2/upload", async (route) => {
      legacyUploadCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobId: "e2e-explicit-rollback" }),
      });
    });
    await page.route(
      "**/api/documents/v2/jobs/e2e-explicit-rollback",
      async (route) => {
        legacyStatusCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "completed",
            result: { markdown: "Explicit rollback content" },
          }),
        });
      },
    );

    await gotoNexus(page);
    await addNexusAttachment(page, {
      name: "nexus-rollback.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Explicit rollback content"),
    });

    await expect(
      page.getByText("nexus-rollback.txt", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeEnabled();
    expect(canonicalNegotiationCount).toBe(1);
    expect(legacyUploadCount).toBe(1);
    expect(legacyStatusCount).toBe(1);
  };

const defineUnifiedContentProductMigrationAuthenticatedSuite2 = () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authenticated local E2E server and unified-content fixtures",
  );

  test("Repository Manager projects exact read-only access and hides owner-only content", defineUnifiedContentProductMigrationAuthenticatedSuite2Registration1);

  test("Repository Manager exposes the universal source workflow and management metadata", defineUnifiedContentProductMigrationAuthenticatedSuite2Registration2);

  test("staff can manage repositories and bind an explicitly shared repository in Assistant Architect", defineUnifiedContentProductMigrationAuthenticatedSuite2Registration3);

  test("authenticated users without Repository Manager capability cannot promote Nexus attachments", defineUnifiedContentProductMigrationAuthenticatedSuite2Registration4);

  test("Assistant Architect uses the shared repository picker and has no direct knowledge upload", defineUnifiedContentProductMigrationAuthenticatedSuite2Registration5);

  test("Assistant Architect runtime sends an opaque temporary repository reference without invoking legacy upload", defineUnifiedContentProductMigrationAuthenticatedSuite2Registration6);

  test("Nexus uploads canonically, sends only an opaque reference, and promotes from the message", defineUnifiedContentProductMigrationAuthenticatedSuite2Registration7);

  test("Nexus canonicalizes image inputs while retaining inline pixels for vision and image editing", defineUnifiedContentProductMigrationAuthenticatedSuite2Registration8);

  test("Nexus rejects forged attachment references before creating a conversation", defineUnifiedContentProductMigrationAuthenticatedSuite2Registration9);

  test("Nexus uses legacy processing only when the canonical endpoint explicitly selects rollback mode", defineUnifiedContentProductMigrationAuthenticatedSuite2Registration10);
};

test.describe("Unified content product migration (authenticated)", defineUnifiedContentProductMigrationAuthenticatedSuite2);
