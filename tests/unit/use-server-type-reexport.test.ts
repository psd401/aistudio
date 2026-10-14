/** @jest-environment node */

/**
 * No "use server" module may re-export a type with a LOCAL `export type { X };`.
 *
 * The dev server compiles that statement inside a server-actions module as a
 * VALUE export. Evaluating the module then throws `ReferenceError: X is not
 * defined`, and every page that pulls in one of its actions fails to render.
 * #1862 shipped exactly this in actions/db/atrium/search-people.ts
 * (`export type { PersonOption };`) and took the Atrium editor down for ~25
 * Playwright specs. TypeScript, lint and the unit suite all passed it — only a
 * running dev server sees the failure, so this check is the cheap catch.
 *
 * Import the type from its source module instead. The `export type { X } from
 * "..."` form is not flagged: it is in use (actions/db/atrium/publish-document.ts)
 * and loaded without error in the same dev-server run.
 */

import { join, relative } from "node:path"

import { validatedFs } from "@/lib/filesystem/validated-fs"

const { readdirSync, readFileSync } = validatedFs

const repoRoot = join(__dirname, "..", "..")
const SCANNED_ROOTS = ["actions", "app", "components", "lib"]

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry.name)) files.push(path)
  }
  return files
}

/** A module-level directive sits at column 0; an inline one is indented. */
const USE_SERVER_DIRECTIVE = /^["']use server["'];?\s*$/m

/**
 * `export type { A, B };` or `export { type A };` with no `from` clause: a
 * re-export of a binding this module imported.
 */
const LOCAL_TYPE_REEXPORT =
  /^export\s+(?:type\s*\{[^}]*\}|\{[^}]*\btype\s+[^}]*\})\s*;?\s*$/gm

describe('"use server" modules', () => {
  const offenders = SCANNED_ROOTS.flatMap((root) =>
    sourceFiles(join(repoRoot, root))
  ).flatMap((file) => {
    const source = readFileSync(file, "utf8")
    if (!USE_SERVER_DIRECTIVE.test(source)) return []
    return [...source.matchAll(LOCAL_TYPE_REEXPORT)].map(
      (match) => `${relative(repoRoot, file)}: ${match[0].trim()}`
    )
  })

  it("never re-export a type with a local `export type { X };`", () => {
    expect(offenders).toEqual([])
  })

  it("would have caught the #1862 statement", () => {
    // Guards the guard: a regex that silently matches nothing passes forever.
    const shipped = '"use server"\n\nexport type { PersonOption };\n'
    expect(USE_SERVER_DIRECTIVE.test(shipped)).toBe(true)
    expect([...shipped.matchAll(LOCAL_TYPE_REEXPORT)]).toHaveLength(1)
    expect(
      [...'export type { EditorPublishDestination } from "@/lib/x";\n'.matchAll(
        LOCAL_TYPE_REEXPORT
      )]
    ).toHaveLength(0)
  })
})
