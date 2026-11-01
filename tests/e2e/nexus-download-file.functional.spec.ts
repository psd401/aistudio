import type { Download, Page } from "@playwright/test";
import JSZip from "jszip";

import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { validatedFs } from "@/lib/filesystem/validated-fs";

/**
 * E2E (gated): flow `nexus-download-file` — Nexus hands back a real file
 * (Issue #1898).
 *
 * The reported gap: asked for a Word document, a spreadsheet, a deck or a PDF,
 * Nexus returned text to copy and paste. ~55 of 375 staff hit this; one teacher
 * pasted the same flyer eight times across four conversations. The fix exposes
 * the existing `documents.create` generator on the chat surface and delivers the
 * result through an authenticated download route.
 *
 * This drives a REAL model, because the thing under test is whether the model
 * reaches for the tool instead of pasting prose — which no stub can show. The
 * deterministic halves are unit-tested:
 *  - markdown -> Word/slides mapping: tests/smoke/nexus-document-markdown.smoke.ts
 *  - tool contract + catalog surface: tests/unit/lib/tools/document-create-tool.test.ts
 *  - download auth (a second user gets 404): tests/unit/nexus-document-download-route.test.ts
 *  - card href trust boundary: tests/unit/nexus-document-download-card.test.tsx
 *
 * What only this spec can show: the card renders in the message, the browser
 * actually receives bytes from `/api/nexus/documents/...`, those bytes open as a
 * real Office file with the requested structure, and — the criterion a presigned
 * URL could not meet — the card still downloads after a full page reload.
 *
 * PREREQUISITES (why this is gated — it is NOT run in CI):
 *  - Host dev server (`bun run server.ts`) with PLAYWRIGHT_AUTH_ENABLED=true and
 *    a chat-capable model configured (docs/guides/e2e-authenticated-testing.md).
 *  - DOCUMENTS_BUCKET_NAME set and writable by the app's AWS credentials.
 */

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? ".verification";
validatedFs.mkdirSync(SHOT_DIR, { recursive: true });

/** The symptom the ticket reported: prose offered in place of a file. */
const PASTE_INSTEAD_PATTERNS = [
  /copy (?:and |-)?paste/i,
  /can(?:no|')?t create (?:a )?(?:file|document|attachment)/i,
  /unable to (?:create|generate|produce) (?:a )?(?:file|document)/i,
  /I can(?:no|')?t (?:generate|produce|attach) files/i,
];

/** Send a chat message and wait for the assistant to finish its reply. */
async function sendChat(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.click();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({
    timeout: 150_000,
  });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: 150_000,
  });
}

/** The download card the tool renderer produces. */
function downloadCard(page: Page) {
  return page.getByTestId("nexus-document-download").last();
}

/** Click the card and return the downloaded file's bytes plus its name. */
async function clickAndDownload(
  page: Page
): Promise<{ filename: string; bytes: Buffer; url: string }> {
  const card = downloadCard(page);
  await expect(card).toBeVisible({ timeout: 150_000 });
  const href = await card.getAttribute("href");
  expect(href, "card links somewhere").toBeTruthy();
  const advertised = await card.getAttribute("data-filename");
  expect(advertised, "card shows a filename").toBeTruthy();
  // The link must be our authenticated route, never a presigned S3 URL: that is
  // what makes the card survive a reload and re-check ownership per request.
  expect(href).toMatch(/^\/api\/nexus\/documents\/v2\/nexus-documents\//);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    card.click(),
  ]);
  const filename = download.suggestedFilename();
  // The browser must save the name the card shows, not the storage basename
  // (the route's Content-Disposition wins over the anchor's `download`).
  expect(filename).toBe(advertised);
  return {
    filename,
    bytes: await readDownload(download),
    url: href as string,
  };
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Read one part out of an OOXML package, proving the bytes are a real file. */
async function openOoxmlPart(bytes: Buffer, part: string): Promise<string> {
  // Every .docx/.pptx is a zip starting "PK".
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file(part);
  expect(entry, `package contains ${part}`).toBeTruthy();
  return (entry as NonNullable<typeof entry>).async("string");
}

test.describe("Nexus returns a downloadable file (#1898)", () => {
  // A real model call plus generation, S3 upload and a download round-trip on a
  // cold dev server needs well over the default per-test budget.
  test.describe.configure({ timeout: 300_000 });

  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated host dev server — see docs/guides/e2e-authenticated-testing.md"
  );

  test(
    "a Word document request produces a .docx with a heading and a bulleted list",
    async ({ browser }) => {
      const context = await browser.newContext({ acceptDownloads: true });
      await authenticateContext(context);
      try {
        const page = await context.newPage();
        await page.goto("/nexus");

        await sendChat(
          page,
          [
            "Turn this list into a Word document I can download.",
            'Title it "Fall Supply List". Use a heading called "Classroom supplies"',
            "and a bulleted list with these items: pencils, glue sticks, wide-ruled paper.",
          ].join(" ")
        );

        const reply = page.locator('[data-role="assistant"]').last();
        const replyText = await reply.innerText();
        for (const pattern of PASTE_INSTEAD_PATTERNS) {
          expect(replyText).not.toMatch(pattern);
        }

        await page.screenshot({
          path: `${SHOT_DIR}/nexus-download-file-docx-card.png`,
          fullPage: true,
        });

        const { filename, bytes } = await clickAndDownload(page);
        expect(filename.endsWith(".docx")).toBe(true);
        expect(bytes.byteLength).toBeGreaterThan(0);

        const xml = await openOoxmlPart(bytes, "word/document.xml");
        // A real Word heading style, not a literal "##" on the page.
        expect(xml).toMatch(/w:val="(?:Title|Heading\d)"/);
        expect(xml).not.toContain("## ");
        // A real bulleted list, not "- " printed as text.
        expect(xml).toContain("<w:numPr>");
        expect(xml).toMatch(/<w:t[^>]*>pencils<\/w:t>/);
        expect(xml).not.toMatch(/<w:t[^>]*>- pencils<\/w:t>/);
      } finally {
        await context.close();
      }
    }
  );

  test(
    "a deck request produces a .pptx with one slide per section (#1693)",
    async ({ browser }) => {
      const context = await browser.newContext({ acceptDownloads: true });
      await authenticateContext(context);
      try {
        const page = await context.newPage();
        await page.goto("/nexus");

        await sendChat(
          page,
          "Make this a 3-slide PowerPoint deck I can download: slide 1 why reading " +
            "aloud matters, slide 2 how to start, slide 3 what to do next. " +
            "Two short bullets per slide."
        );

        await page.screenshot({
          path: `${SHOT_DIR}/nexus-download-file-pptx-card.png`,
          fullPage: true,
        });

        const { filename, bytes } = await clickAndDownload(page);
        expect(filename.endsWith(".pptx")).toBe(true);

        const presentation = await openOoxmlPart(
          bytes,
          "ppt/presentation.xml"
        );
        expect(presentation).toContain("<p:sldIdLst>");
        const zip = await JSZip.loadAsync(bytes);
        const slideCount = Object.keys(zip.files).filter((name) =>
          /^ppt\/slides\/slide\d+\.xml$/.test(name)
        ).length;
        // 3 content slides, plus a cover slide when the model supplied a title.
        expect(slideCount).toBeGreaterThanOrEqual(3);
      } finally {
        await context.close();
      }
    }
  );

  test(
    "the card still downloads after the conversation is reloaded",
    async ({ browser }) => {
      const context = await browser.newContext({ acceptDownloads: true });
      await authenticateContext(context);
      try {
        const page = await context.newPage();
        await page.goto("/nexus");

        await sendChat(
          page,
          'Create a Word document titled "Reload Check" with a heading ' +
            '"Checklist" and one bullet: confirm the link still works.'
        );
        const before = await clickAndDownload(page);

        // Reopen the conversation the way a user does from the sidebar:
        // `/nexus?id=<uuid>`. Nexus keeps the new conversation's id in React
        // state (`applyConversationHeader` -> `onConversationIdChange`) rather
        // than pushing it into the URL, so re-visiting `page.url()` would start
        // a BLANK conversation and this test would pass for the wrong reason.
        // The id is embedded in the download key itself.
        const conversationId = before.url.split("/")[6];
        expect(conversationId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
        // A full document load, not a client-side re-render: this is the
        // criterion a one-hour presigned URL in a persisted message could not
        // meet.
        await page.goto(`/nexus?id=${conversationId}`);

        const after = await clickAndDownload(page);
        expect(after.url).toBe(before.url);
        expect(after.filename).toBe(before.filename);
        expect(after.bytes.byteLength).toBe(before.bytes.byteLength);

        await page.screenshot({
          path: `${SHOT_DIR}/nexus-download-file-after-reload.png`,
          fullPage: true,
        });
      } finally {
        await context.close();
      }
    }
  );
});
