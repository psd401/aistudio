/**
 * Drift guard for the /admin hub registry (app/(protected)/admin/_lib/
 * admin-pages.ts).
 *
 * Every admin page.tsx must have a registry entry (or it silently misses the
 * hub, which is now the only navigation into the admin area), and every
 * registry entry must point at a real page. Dynamic segments ([userEmail])
 * are excluded — they cannot be static cards.
 */
import { readdirSync } from "node:fs"
import path from "node:path"
import { ALL_ADMIN_PAGES, adminPageMetadata } from "@/app/(protected)/admin/_lib/admin-pages"

const ADMIN_DIR = path.join(process.cwd(), "app", "(protected)", "admin")

function discoverAdminRoutes(): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path derived from process.cwd(), no user input
  const entries = readdirSync(ADMIN_DIR, { recursive: true }) as string[]
  return entries
    .filter(entry => entry.endsWith(`${path.sep}page.tsx`))
    .map(entry => path.dirname(entry).split(path.sep).join("/"))
    .filter(route => !route.includes("[")) // dynamic segments can't be cards
    .map(route => `/admin/${route}`)
    .sort()
}

describe("admin hub registry drift", () => {
  it("registers every admin page.tsx in ALL_ADMIN_PAGES", () => {
    const discovered = discoverAdminRoutes()
    const registered = ALL_ADMIN_PAGES.map(page => page.href).sort()

    // Bidirectional: a missing registry entry AND a stale registry entry both
    // fail, with the offending routes visible in the diff.
    expect(discovered).toEqual(registered)
  })

  it("has unique hrefs and slugs", () => {
    const hrefs = ALL_ADMIN_PAGES.map(page => page.href)
    const slugs = ALL_ADMIN_PAGES.map(page => page.slug)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it("adminPageMetadata resolves registry entries and falls back safely", () => {
    expect(adminPageMetadata("/admin/users").title).toBe("User Management | Admin")
    expect(adminPageMetadata("/admin/does-not-exist").title).toBe("Admin")
  })
})
