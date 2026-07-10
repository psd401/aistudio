/**
 * Capability catalog generator CLI (Issue #1100).
 *
 * Writes the committed snapshot of AI Studio's capability catalog — the live
 * projection of `TOOL_MANIFEST` + `CAPABILITY_MANIFEST` + `API_SCOPES`/`ROLE_SCOPES`
 * built by `lib/capabilities/capability-catalog.ts`. Mirrors the OpenAPI generator
 * (`scripts/openapi/generate-from-catalog.ts`): the file is checked in, and CI runs
 * `--check` so a registry change that isn't regenerated fails the build. This is the
 * drift guard and the seed for a future OpenWiki capability page.
 *
 * Output: `docs/API/v1/generated/capability-catalog.json`.
 *
 * Usage:
 *   bun run capabilities:generate     # write the catalog
 *   bun run capabilities:check        # fail (exit 1) if the committed catalog drifts
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { buildCapabilityCatalog } from "@/lib/capabilities/capability-catalog"

const OUTPUT_PATH = join(
  process.cwd(),
  "docs/API/v1/generated/capability-catalog.json"
)

/** Deterministic, newline-terminated JSON so the committed file diffs cleanly. */
function serialize(): string {
  return JSON.stringify(buildCapabilityCatalog(), null, 2) + "\n"
}

function main(): void {
  const check = process.argv.includes("--check")
  const content = serialize()

  if (check) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error(
        `[capabilities] ${OUTPUT_PATH} is missing. Run \`bun run capabilities:generate\`.`
      )
      process.exit(1)
    }
    const current = readFileSync(OUTPUT_PATH, "utf8")
    if (current !== content) {
      console.error(
        "[capabilities] Generated capability catalog is out of date. " +
          "Run `bun run capabilities:generate` and commit the result."
      )
      process.exit(1)
    }
    console.log("[capabilities] capability-catalog.json is in sync.")
    return
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, content)
  console.log(`[capabilities] Wrote ${OUTPUT_PATH}`)
}

main()
