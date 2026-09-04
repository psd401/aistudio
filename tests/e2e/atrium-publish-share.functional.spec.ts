import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
  SEEDED_NO_CAPABILITY_EMAIL,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

/**
 * E2E functional coverage for the Atrium sharing/publish cluster (#1336, #1726).
 *
 * Flows: `atrium-publish-visibility`, `atrium-share-url`,
 * `atrium-share-grants`.
 *
 * The defect #1726 closes: visibility ("Level") and publication ("Where it's
 * published") were two independent AUDIENCE switches reconciled by a "Widen who
 * can see this?" prompt. The prompt's claim was false — `/c/[slug]` runs
 * `canView` before it looks at the publication — and confirming it replaced the
 * author's grant set with none. Publication is now one Live/Draft state and the
 * Level alone decides the audience.
 *
 *  - LIVE + GRANTS. A Group document with one person grant is published. The
 *    grantee opens `/c/{slug}` and gets 200; a non-grantee gets 404; and the
 *    owner's grant list is INTACT afterwards — the assertion that would have
 *    failed under the old widen. Toggling back to Draft sends the grantee to the
 *    authoring surface instead.
 *  - PUBLIC IS DERIVED. Setting the Level to Public on a Live document makes
 *    `/p/{slug}` resolve for an ANONYMOUS context with no second switch to
 *    throw, and the Share dialog offers the public link. An admin-visible
 *    notification lands on /admin/atrium.
 *  - GRANTS (C5). The Share affordance is labelled (not a bare status badge),
 *    the people picker finds a user by name/email, and the resulting grant lets
 *    that user read `/c/{slug}`.
 *
 * Auth: see helpers/session-auth. Gated behind PLAYWRIGHT_AUTH_ENABLED.
 */

const SHOT_DIR = '.verification'

function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}


/**
 * Best-effort teardown for objects a spec created. Leaving rows behind grows the
 * shared local library on every run, which makes UNRELATED library specs slower
 * and flakier (they page through the same list). Published objects are refused
 * by delete, so they are unpublished first. Failures are ignored — teardown must
 * never mask the real assertion failure.
 */
async function cleanup(
  page: import('@playwright/test').Page,
  ids: string[]
): Promise<void> {
  for (const id of ids) {
    try {
      await page.request.post(`/api/v1/content/${id}/unpublish`, {
        data: { destination: 'intranet' },
      })
      await page.request.delete(`/api/v1/content/${id}`)
    } catch {
      // Ignored on purpose — see the docblock.
    }
  }
}

/** Create a doc via the REST API and return `{ id, slug }`. */
async function seedDoc(
  page: import('@playwright/test').Page,
  title: string
): Promise<{ id: string; slug: string }> {
  const res = await page.request.post('/api/v1/content', {
    data: {
      kind: 'document',
      title,
      body: `# ${title}\n\nBody text for ${title}.`,
      bodyFormat: 'markdown',
      visibility: { level: 'private' },
    },
  })
  expect(res.status()).toBe(201)
  const data = (await res.json())?.data
  expect(data?.id).toBeTruthy()
  expect(data?.slug).toBeTruthy()
  return { id: data.id as string, slug: data.slug as string }
}

/** Open the Share control and flip the object Live. */
async function openAndPublish(page: import('@playwright/test').Page) {
  // One switch, no destination step (#1726): publication is a state, so the
  // dialog offers Publish / Republish / Unpublish and nothing else.
  await page.getByTestId('share-control').click()
  // The button stays disabled ("Checking…") until the dialog has resolved the
  // object's live state and level — the consequence line cannot be written
  // truthfully before then. Waiting for it to enable is the honest readiness
  // signal.
  const publishButton = page.getByTestId('share-publish')
  await expect(publishButton).toBeEnabled({ timeout: 60000 })
  await publishButton.click()
}

/** Set the Level in the open Share dialog and save. */
async function setLevel(
  page: import('@playwright/test').Page,
  label: 'Private' | 'Group' | 'Internal' | 'Public'
) {
  await page.getByLabel('Level').click()
  await page.getByRole('option', { name: label, exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
}

function defineAtriumPublishShareAuthenticatedSuite1Part1() {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  // These flows fan out several server actions (archive/restore/delete,
  // publish + widen) against a Next DEV server that compiles each action on
  // first hit, so the default 60s per-test budget is genuinely too tight here.
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('atrium-publish-visibility: a Group document goes Live WITHOUT losing its grants, and only its grantees can read /c/{slug}', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      const token = runToken()
      const { id, slug } = await seedDoc(page, `Group publish ${token}`)

      // Group visibility with ONE grant, set through the API so the test starts
      // from the exact state #1726 is about.
      const scoped = await page.request.patch(
        `/api/v1/content/${id}/visibility`,
        {
          data: {
            level: 'group',
            // A ROLE grant, so the fixture needs no numeric user id: the seeded
            // student holds `student` and nothing else.
            grants: [{ kind: 'role', value: 'student' }],
          },
        }
      )
      expect([200, 201]).toContain(scoped.status())

      await page.goto(`/atrium/${id}/edit`)
      await expect(page.getByTestId('share-control')).toBeVisible({
        timeout: 30000,
      })

      await page.getByTestId('share-control').click()
      // Draft to begin with: no Live badge and no Unpublish button at all (the
      // dialog renders that action only for a live object rather than disabling
      // it).
      await expect(page.getByTestId('share-live-state')).toHaveAttribute(
        'data-live',
        'false'
      )
      await expect(page.getByTestId('share-unpublish')).toHaveCount(0)
      // The connectors are a separate concept and are disabled, not offered as
      // publish destinations.
      await expect(page.getByTestId('share-connector-schoology')).toBeVisible()
      await page.keyboard.press('Escape')

      // Publish. There is NO widen prompt: the old dialog claimed a Group
      // document published to the intranet would be "a live page its readers
      // cannot open" and offered to fix it by wiping the grants.
      await openAndPublish(page)
      await expect(page.getByTestId('share-widen-confirm')).toHaveCount(0)

      await expect(page.getByTestId('share-live-state')).toHaveAttribute(
        'data-live',
        'true',
        { timeout: 60000 }
      )
      // The switch STATES its consequence instead of asking a question, and the
      // sentence is true: one grantee.
      await expect(page.getByTestId('share-consequence')).toContainText(
        /Live for the 1 person or group you've granted/
      )
      await expect(page.getByTestId('share-live-badge')).toBeVisible()
      await expect(page.getByTestId('share-unpublish')).toBeEnabled()

      const readerLink = page.getByTestId('share-link-url')
      await expect
        .poll(
          async () =>
            (await readerLink.textContent())?.trim().endsWith(`/c/${slug}`),
          { timeout: 60000 }
        )
        .toBe(true)
      // Not Public, so no public address is offered — the link section derives
      // it from Level + Live rather than from a second switch.
      await expect(page.getByTestId('share-public-link')).toHaveCount(0)
      await page.screenshot({
        path: `${SHOT_DIR}/atrium-publish-visibility.png`,
        fullPage: false,
      })

      // THE ASSERTION #1726 EXISTS FOR: the grant survived the publish, and so
      // did the Level. Confirming the old widen set the level to Internal and ran
      // it through `setLevelInTx`, which REPLACES the grant set — so this chip
      // was gone and the picker was back to Everyone signed in.
      await expect(page.getByLabel('Level')).toContainText('Group')
      await expect(page.getByText('role', { exact: true })).toBeVisible()
      await expect(
        page.locator('span', { hasText: /^student$/ }).first()
      ).toBeVisible()

      // The grantee can read the reader page; the audience really is the Level.
      const granteeContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      })
      await authenticateContext(
        granteeContext,
        SEEDED_NO_CAPABILITY_EMAIL,
        'e2e-student-user'
      )
      try {
        const granteePage = await granteeContext.newPage()
        const resp = await granteePage.goto(`/c/${slug}`)
        expect(resp?.status()).toBe(200)
        await expect(
          granteePage.getByText(`Body text for Group publish ${token}`)
        ).toBeVisible({ timeout: 60000 })
        await granteePage.screenshot({
          path: `${SHOT_DIR}/atrium-publish-visibility-reader.png`,
          fullPage: false,
        })

        // Back to Draft: the reader page stops existing for the grantee, who is
        // redirected to the authoring surface rather than shown a 404.
        await page.getByTestId('share-unpublish').click()
        await expect(page.getByTestId('share-live-state')).toHaveAttribute(
          'data-live',
          'false',
          { timeout: 60000 }
        )
        await granteePage.goto(`/c/${slug}`)
        await expect(granteePage).toHaveURL(/\/atrium\//, { timeout: 60000 })
      } finally {
        await granteeContext.close()
      }

      await cleanup(page, [id])
    } finally {
      await context.close()
    }
  })

  }

function defineAtriumPublishShareAuthenticatedSuite1Part2() {test('atrium-share-url: Public + Live derives the /p/{slug} address, it resolves anonymously, and the exposure is recorded', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      const token = runToken()
      const { id, slug } = await seedDoc(page, `Public publish ${token}`)

      await page.goto(`/atrium/${id}/edit`)
      await expect(page.getByTestId('share-control')).toBeVisible({
        timeout: 30000,
      })

      // Publish first — while the level is still Private, which the old dialog
      // would have blocked behind the widen prompt.
      await openAndPublish(page)
      await expect(page.getByTestId('share-live-state')).toHaveAttribute(
        'data-live',
        'true',
        { timeout: 60000 }
      )
      // Live but Private: no public address yet, and the consequence line says
      // exactly that rather than implying a broader audience.
      await expect(page.getByTestId('share-public-link')).toHaveCount(0)
      await expect(page.getByTestId('share-consequence')).toContainText(
        /only you and administrators/i
      )

      // Now the ONLY switch that changes the audience: the Level.
      await setLevel(page, 'Public')

      // The public address is DERIVED — no second "publish to the public web"
      // step, so the #1336 dead-link states cannot occur.
      await page.getByTestId('share-control').click()
      const publicLink = page.getByTestId('share-public-link-url')
      await expect
        .poll(
          async () =>
            (await publicLink.textContent())?.trim().endsWith(`/p/${slug}`),
          { timeout: 60000 }
        )
        .toBe(true)
      await expect(page.getByTestId('share-consequence')).toContainText(
        /no sign-in/i
      )
      await page.screenshot({
        path: `${SHOT_DIR}/atrium-share-url.png`,
        fullPage: false,
      })
      await page.keyboard.press('Escape')

      // An ANONYMOUS context (no session at all) can read it.
      const anon = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      })
      try {
        const anonPage = await anon.newPage()
        const resp = await anonPage.goto(`/p/${slug}`)
        expect(resp?.status()).toBe(200)
        await expect(
          anonPage.getByText(`Body text for Public publish ${token}`)
        ).toBeVisible({ timeout: 60000 })
        await anonPage.screenshot({
          path: `${SHOT_DIR}/atrium-share-url-anonymous.png`,
          fullPage: false,
        })
      } finally {
        await anon.close()
      }

      // Allow-then-NOTIFY: the public exposure is recorded on /admin/atrium.
      // (The seeded E2E identity is an admin, and admin actions are deliberately
      // NOT notified — so this asserts the audit surface renders the `ui`
      // surface and the public-exposure flag at all, which is the mechanism the
      // non-admin path writes through.)
      await page.goto('/admin/atrium')
      await page.getByRole('tab', { name: /Audit/i }).click()
      await expect(
        page.getByRole('combobox', { name: 'Filter by surface' })
      ).toBeVisible({ timeout: 60000 })
      await page.screenshot({
        path: `${SHOT_DIR}/atrium-admin-audit.png`,
        fullPage: false,
      })

      await cleanup(page, [id])
    } finally {
      await context.close()
    }
  })

  }

function defineAtriumPublishShareAuthenticatedSuite1Part3() {test('atrium-share-grants: the labelled Share control adds a person grant via search, and that user can then read /c/{slug}', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      const token = runToken()
      const { id, slug } = await seedDoc(page, `Grant probe ${token}`)

      // Publish to the intranet so the reader route has a live publication —
      // the grant then decides who may actually open it.
      const published = await page.request.post(
        `/api/v1/content/${id}/publish`,
        { data: { destination: 'intranet' } }
      )
      expect([200, 201]).toContain(published.status())

      await page.goto(`/atrium/${id}/edit`)

      // The entry point is a LABELLED "Share" control, not a bare status badge.
      const share = page.getByTestId('share-control')
      await expect(share).toBeVisible({ timeout: 30000 })
      await expect(share).toContainText('Share')
      await share.click()

      // Switch to Group visibility and add a PERSON grant via the picker —
      // previously this field demanded a raw numeric users.id.
      await page.getByLabel('Level').click()
      await page.getByRole('option', { name: 'Group', exact: true }).click()
      await page.getByLabel('Kind').click()
      await page.getByRole('option', { name: 'Person', exact: true }).click()

      const picker = page.getByTestId('people-picker-input')
      await expect(picker).toBeVisible({ timeout: 15000 })
      await picker.fill('student')
      const results = page.getByTestId('people-picker-results')
      await expect(results).toBeVisible({ timeout: 60000 })
      await page.screenshot({
        path: `${SHOT_DIR}/atrium-share-grants.png`,
        fullPage: false,
      })
      await results.getByRole('button').first().click()

      // The grant chip appears, then save.
      //
      // It reads "person <Name>", not "user <id>". A `user` grant stores the
      // numeric users.id, and the chip used to render that verbatim — correct
      // and unusable, since nobody can confirm they shared a page with the
      // right colleague by reading a primary key. The kind now matches the
      // picker's own "Person" label and the value is the resolved name.
      await expect(page.getByText('person', { exact: true })).toBeVisible()
      // The name itself, not just the kind: this is the assertion that would
      // catch a regression back to rendering the raw id.
      await expect(
        page.locator('span', { hasText: /^Student/ }).first()
      ).toBeVisible()
      await page.getByRole('button', { name: 'Save', exact: true }).click()

      // The granted user can now read the intranet reader.
      const otherContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      })
      await authenticateContext(
        otherContext,
        SEEDED_NO_CAPABILITY_EMAIL,
        'e2e-student-user'
      )
      try {
        const otherPage = await otherContext.newPage()
        const resp = await otherPage.goto(`/c/${slug}`)
        expect(resp?.status()).toBe(200)
        await expect(
          otherPage.getByText(`Body text for Grant probe ${token}`)
        ).toBeVisible({ timeout: 60000 })
      } finally {
        await otherContext.close()
      }

      await cleanup(page, [id])
    } finally {
      await context.close()
    }
  })
}

const defineAtriumPublishShareAuthenticatedSuite1 = () => {
  defineAtriumPublishShareAuthenticatedSuite1Part1()
  defineAtriumPublishShareAuthenticatedSuite1Part2()
  defineAtriumPublishShareAuthenticatedSuite1Part3()
};

test.describe('Atrium publish + share (authenticated)', defineAtriumPublishShareAuthenticatedSuite1)
