import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { test, expect, type Page } from './fixtures'
import { authenticateContext } from './helpers/session-auth'
import { gotoNexus, sendMessage, waitForStreamingComplete } from './nexus/utils'

/**
 * Prod, 2026-10-26: a teacher attached scanned multiple-choice answer sheets and
 * asked Nexus to score them. The model only received the PDF's extracted text,
 * where every item reads "A B C D" — the circles are drawings, not text — so it
 * could not see which letter each student chose.
 *
 * The current turn's PDFs are now also sent to the model as documents it reads
 * visually (app/api/nexus/chat/pdf-attachment-documents.ts). This live spec
 * attaches a sheet whose answers exist ONLY as drawn circles and asks for them;
 * the right answer is impossible from extracted text alone.
 *
 * Live: needs Bedrock credentials (E2E_RUN_EXTERNAL=1) AND repository-backed
 * attachments. A local stack without the content-processing workers falls back
 * to the legacy upload path (no repository marker), where this feature does not
 * apply, so the spec skips there. The route's message shape is also verified
 * against Bedrock directly (see the PR) and unit-tested.
 */

const CIRCLED = ['C', 'A', 'D'] as const

async function answerSheetPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  page.drawText('Multiple Choice Answers (circle one)', { x: 50, y: 740, size: 12, font })
  for (const [i, answer] of CIRCLED.entries()) {
    const y = 690 - i * 40
    page.drawText(`${i + 1}.`, { x: 50, y, size: 14, font })
    for (const [j, letter] of ['A', 'B', 'C', 'D'].entries()) {
      const x = 100 + j * 50
      page.drawText(letter, { x, y, size: 14, font })
      if (letter === answer) {
        page.drawEllipse({ x: x + 4, y: y + 5, xScale: 12, yScale: 12, borderColor: rgb(0, 0, 0), borderWidth: 1.5 })
      }
    }
  }
  return Buffer.from(await doc.save())
}

async function chooseAdvancedClaude(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Nexus routing mode' }).click()
  await page.getByTestId('nexus-mode-advanced').click()
  await page.getByTestId('nexus-family-anthropic').click()
  await expect(page.getByRole('button', { name: 'Nexus routing mode' })).toContainText('Claude')
}

async function restoreStandardMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Nexus routing mode' }).click()
  await page.getByTestId('nexus-mode-standard').click()
}

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Nexus reads attached PDFs visually', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true' || process.env.E2E_RUN_EXTERNAL !== '1',
    'Requires authenticated local E2E plus live Bedrock credentials',
  )
  test.describe.configure({ timeout: 300_000 })

  test('reads circled answers that do not exist in the extracted text', async ({ page }, testInfo) => {
    await authenticateContext(page.context())
    await gotoNexus(page)
    await chooseAdvancedClaude(page)
    try {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: /add attachment/i }).click()
      await (await chooser).setFiles({
        name: 'answer-sheet.pdf',
        mimeType: 'application/pdf',
        buffer: await answerSheetPdf(),
      })
      await expect(page.getByText('answer-sheet.pdf').first()).toBeVisible({ timeout: 60_000 })

      await sendMessage(
        page,
        'Which letter is circled for questions 1, 2 and 3 on the attached sheet? Reply exactly in the form 1=X 2=X 3=X.',
      )
      // The sent message shows a repository card only for repository-backed attachments.
      const repositoryBacked = await page
        .getByText(/temporary repository attachment/i)
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true, () => false)
      test.skip(!repositoryBacked, 'Attachments are not repository-backed in this environment')
      await waitForStreamingComplete(page, 240_000)

      const reply = page.locator('[data-role="assistant"]').last()
      await expect(reply).toContainText(/1\s*=\s*C/, { timeout: 60_000 })
      await expect(reply).toContainText(/2\s*=\s*A/)
      await expect(reply).toContainText(/3\s*=\s*D/)

      await page.screenshot({ path: testInfo.outputPath('nexus-pdf-visual-reading.png'), fullPage: true })
    } finally {
      await restoreStandardMode(page)
    }
  })
})
