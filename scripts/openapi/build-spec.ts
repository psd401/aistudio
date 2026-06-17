/**
 * Catalog → OpenAPI spec builder (Issue #924, AC #4) — pure, side-effect-free.
 *
 * Builds the OpenAPI fragment for every REST-surfaced tool in the catalog
 * manifest. Kept separate from the CLI (`generate-from-catalog.ts`) so it can be
 * unit-tested without filesystem I/O. The spec is the tool-backed portion of the
 * REST API surface; the hand-authored `docs/API/v1/openapi.yaml` covers the rest.
 */

import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest"
import type { ToolManifestEntry } from "@/lib/tools/catalog/types"

/** Resolve the REST scopes for a manifest entry (surface override or base). */
export function restScopes(entry: ToolManifestEntry): string[] {
  return entry.surfaceScopes?.rest ?? entry.requiredScopes
}

/** Extract `{param}` names from an OpenAPI path template. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
}

export interface OpenApiOperation {
  operationId: string
  summary: string
  description?: string
  "x-tool-identifier": string
  "x-tool-version": string
  parameters?: Array<{
    name: string
    in: "path"
    required: true
    schema: { type: string }
  }>
  security: Array<Record<string, string[]>>
  responses: Record<string, { description: string }>
}

type RestEntry = ToolManifestEntry & {
  rest: NonNullable<ToolManifestEntry["rest"]>
}

/** REST-surfaced tools that declare a binding, sorted for deterministic output. */
export function restEntries(): RestEntry[] {
  return TOOL_MANIFEST.filter(
    (e): e is RestEntry => e.surfaces.includes("rest") && e.rest !== undefined
  ).sort((a, b) =>
    a.rest.path === b.rest.path
      ? a.rest.method.localeCompare(b.rest.method)
      : a.rest.path.localeCompare(b.rest.path)
  )
}

/** Build the deterministic OpenAPI fragment from the catalog manifest. */
export function buildSpec() {
  const paths: Record<string, Record<string, OpenApiOperation>> = {}
  for (const entry of restEntries()) {
    const { method, path, summary, description, operationId } = entry.rest
    const params = pathParams(path)
    const operation: OpenApiOperation = {
      operationId: operationId ?? entry.identifier,
      summary,
      ...(description ? { description } : {}),
      "x-tool-identifier": entry.identifier,
      "x-tool-version": entry.version ?? "v1",
      ...(params.length > 0
        ? {
            parameters: params.map((name) => ({
              name,
              in: "path" as const,
              required: true as const,
              // Numeric resource ids in v1 routes; default to integer for `id`.
              schema: { type: name === "id" ? "integer" : "string" },
            })),
          }
        : {}),
      security: [{ ApiKeyAuth: restScopes(entry) }],
      responses: { "200": { description: "Success" } },
    }
    paths[path] = { ...(paths[path] ?? {}), [method]: operation }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "AI Studio API — catalog-generated tool endpoints",
      version: "1.0",
      description:
        "GENERATED from the tool catalog (lib/tools/catalog/manifest.ts) by " +
        "scripts/openapi/generate-from-catalog.ts. Do not edit by hand; run " +
        "`bun run openapi:generate`. This fragment covers tool-backed REST " +
        "endpoints (surfaces include `rest`); the hand-authored docs/API/v1/" +
        "openapi.yaml covers the rest of the surface.",
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "http", scheme: "bearer" },
      },
    },
    paths,
  }
}

/** Canonical serialization used by both the writer and the drift check. */
export function serialize(spec: unknown): string {
  return JSON.stringify(spec, null, 2) + "\n"
}
