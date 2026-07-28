import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@jest/globals"

const openapi = readFileSync(
  join(process.cwd(), "docs/API/v1/openapi.yaml"),
  "utf8"
)

function schemaBlock(name: string, nextName: string): string {
  const startMarker = `    ${name}:`
  const endMarker = `    ${nextName}:`
  const start = openapi.indexOf(startMarker)
  const end = openapi.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) {
    throw new Error(`Missing OpenAPI schema boundary: ${name} -> ${nextName}`)
  }
  return openapi.slice(start, end)
}

describe("Assistant Architect import OpenAPI contract", () => {
  it("documents every runtime-nullable portable property as nullable", () => {
    const prompt = schemaBlock(
      "AssistantImportPrompt",
      "AssistantImportField"
    )
    const field = schemaBlock(
      "AssistantImportField",
      "AssistantImportDefinition"
    )
    const assistant = schemaBlock(
      "AssistantImportDefinition",
      "AssistantImportEnvelope"
    )

    expect(prompt).toMatch(
      /system_context:\n\s+type: \[string, "null"\]/
    )
    expect(prompt).toContain(
      'parallel_group: { type: [integer, "null"] }'
    )
    expect(prompt).toMatch(
      /input_mapping:\n\s+type: \[object, "null"\]/
    )
    expect(prompt).toMatch(
      /timeout_seconds:\n\s+type: \[integer, "null"\]\n\s+minimum: 1/
    )
    expect(field).toMatch(/options:\n\s+type: \[object, "null"\]/)
    expect(assistant).toContain(
      'image_path: { type: [string, "null"] }'
    )
    expect(assistant).toMatch(
      /timeout_seconds:\n\s+type: \[integer, "null"\]\n\s+minimum: 1/
    )
  })

  it("documents the update route's bounded-body 413 response", () => {
    const assistantPath = openapi.indexOf("  /assistants/{id}:")
    const updateOperation = openapi.indexOf("    put:", assistantPath)
    const forkPath = openapi.indexOf(
      "  /assistants/{id}/fork:",
      updateOperation
    )
    expect(assistantPath).toBeGreaterThanOrEqual(0)
    expect(updateOperation).toBeGreaterThan(assistantPath)
    expect(forkPath).toBeGreaterThan(updateOperation)

    expect(openapi.slice(updateOperation, forkPath)).toMatch(
      /"413":\n\s+description: Assistant import envelope exceeds the 10 MB limit\./
    )
  })
})
