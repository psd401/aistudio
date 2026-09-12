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

const OUTPUT_PATH = join(
  process.cwd(),
  "docs/API/v1/generated/capability-catalog.json"
)

/**
 * #1750 — pin the artifact CDN allowlist before the catalog is built.
 *
 * `create_artifact` / `create_version` carry the sandbox CSP rule in their
 * descriptions, and that sentence names the CDN origins the sandbox actually
 * permits. The app reads them from `ATRIUM_ALLOWED_ARTIFACT_CDNS`, which
 * deployed tasks receive from the `atriumAllowedArtifactCdns` key in
 * `infra/cdk.json` — the same key `AtriumSandboxStack` renders the enforced CSP
 * from.
 *
 * That env var is absent on a developer machine and in CI, and present in every
 * deployed environment, so reading the ambient value would make this COMMITTED
 * snapshot depend on who generated it: CI would write "no external scripts at
 * all" while every real deployment permits a CDN, and a developer who set the
 * variable locally (as .env.example suggests for testing) would regenerate a
 * different file and trip `--check` for everyone else.
 *
 * Generating against the committed cdk.json default fixes both: the snapshot is
 * byte-identical everywhere AND it describes what deployments actually enforce.
 */
function pinArtifactCdnAllowlist(): void {
  const cdkJsonPath = join(process.cwd(), "infra", "cdk.json")
  const cdkJson = JSON.parse(readFileSync(cdkJsonPath, "utf8")) as {
    context?: Record<string, unknown>
  }
  const configured = cdkJson.context?.atriumAllowedArtifactCdns
  if (typeof configured !== "string") {
    console.error(
      "[capabilities] infra/cdk.json context.atriumAllowedArtifactCdns must be " +
        "a comma-separated string; the generated catalog would describe a CSP " +
        "no deployment enforces."
    )
    process.exit(1)
  }
  process.env.ATRIUM_ALLOWED_ARTIFACT_CDNS = configured
}

/** Deterministic, newline-terminated JSON so the committed file diffs cleanly. */
async function serialize(): Promise<string> {
  // Imported dynamically, AFTER the env var above is pinned: the MCP content
  // tools resolve the CSP sentence into a module-level const at import time, so
  // a static import here would capture the ambient value before we set it.
  const { buildCapabilityCatalog } = await import(
    "@/lib/capabilities/capability-catalog"
  )
  return JSON.stringify(buildCapabilityCatalog(), null, 2) + "\n"
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check")
  pinArtifactCdnAllowlist()
  const content = await serialize()

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

void main()
