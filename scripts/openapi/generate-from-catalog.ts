/**
 * Catalog → OpenAPI generator CLI (Issue #924, AC #4).
 *
 * Writes the OpenAPI `paths` + security for every REST-surfaced tool in the tool
 * catalog manifest, so the REST tool-endpoint portion of the API spec is GENERATED
 * from the single source of truth rather than hand-written. The pure builder lives
 * in `build-spec.ts`; this file is the thin filesystem/CLI wrapper.
 *
 * Output: `docs/API/v1/generated/tool-catalog.openapi.json`.
 *
 * Usage:
 *   bun run openapi:generate          # write the spec
 *   bun run openapi:check             # fail (exit 1) if the committed spec drifts
 *
 * The committed file is checked in; CI runs `--check` so a manifest change that
 * isn't regenerated fails the build. Run without `--check` to update it.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { buildSpec, serialize } from "./build-spec"

const OUTPUT_PATH = join(
  process.cwd(),
  "docs/API/v1/generated/tool-catalog.openapi.json"
)

function main() {
  const check = process.argv.includes("--check")
  const content = serialize(buildSpec())

  if (check) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error(
        `[openapi] ${OUTPUT_PATH} is missing. Run \`bun run openapi:generate\`.`
      )
      process.exit(1)
    }
    const current = readFileSync(OUTPUT_PATH, "utf8")
    if (current !== content) {
      console.error(
        "[openapi] Generated tool-endpoint spec is out of date. " +
          "Run `bun run openapi:generate` and commit the result."
      )
      process.exit(1)
    }
    console.log("[openapi] tool-catalog.openapi.json is in sync.")
    return
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, content)
  console.log(`[openapi] Wrote ${OUTPUT_PATH}`)
}

main()
