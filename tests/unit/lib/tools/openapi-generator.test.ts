import { describe, it, expect } from "@jest/globals"
import { buildSpec, restEntries, pathParams } from "@/scripts/openapi/build-spec"
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest"

/**
 * Catalog → OpenAPI generator (#924 AC #4). Pins that every REST-surfaced catalog
 * tool is emitted with the REST scope (not the MCP scope) and a valid operation,
 * so the generated tool-endpoint spec stays a faithful projection of the catalog.
 */

describe("catalog → OpenAPI generator", () => {
  it("emits an operation for every rest-surfaced manifest tool", () => {
    const spec = buildSpec()
    const emittedToolIds = Object.values(spec.paths)
      .flatMap((methods) => Object.values(methods))
      .map((op) => op["x-tool-identifier"])

    const expected = restEntries().map((e) => e.identifier)
    expect(expected.length).toBeGreaterThan(0)
    expect(emittedToolIds.sort()).toEqual(expected.sort())
  })

  it("uses the REST surface scope, not the MCP scope, for assistants.execute", () => {
    const spec = buildSpec()
    const op = spec.paths["/api/v1/assistants/{id}/execute"]?.post
    expect(op).toBeDefined()
    expect(op?.security).toEqual([{ ApiKeyAuth: ["assistants:execute"] }])
    // The MCP scope must NOT leak into the REST spec.
    expect(JSON.stringify(op?.security)).not.toContain("mcp:execute_assistant")
  })

  it("emits a path parameter for templated routes", () => {
    const spec = buildSpec()
    const op = spec.paths["/api/v1/assistants/{id}/execute"]?.post
    expect(op?.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "integer" } },
    ])
    expect(pathParams("/api/v1/assistants/{id}/execute")).toEqual(["id"])
  })

  it("produces a structurally valid OpenAPI 3.1 document with bearer security", () => {
    const spec = buildSpec()
    expect(spec.openapi).toBe("3.1.0")
    expect(spec.components.securitySchemes.ApiKeyAuth).toEqual({
      type: "http",
      scheme: "bearer",
    })
  })

  it("only emits tools that declare both a rest surface AND a binding", () => {
    // Every emitted entry must be a TOOL_MANIFEST entry with surfaces incl. rest.
    for (const entry of restEntries()) {
      const manifestEntry = TOOL_MANIFEST.find((e) => e.identifier === entry.identifier)
      expect(manifestEntry?.surfaces).toContain("rest")
      expect(manifestEntry?.rest).toBeDefined()
    }
  })

  it("documents auth/scope/server error codes on every operation (CLAUDE.md)", () => {
    const spec = buildSpec()
    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods)) {
        // Base errors apply to every authenticated tool endpoint.
        expect(op.responses).toHaveProperty("401")
        expect(op.responses).toHaveProperty("403")
        expect(op.responses).toHaveProperty("500")
      }
    }
  })

  it("emits the execute route's dual-mode success codes (200 SSE, 202 async)", () => {
    const op = buildSpec().paths["/api/v1/assistants/{id}/execute"]?.post
    expect(op?.responses).toHaveProperty("200")
    expect(op?.responses).toHaveProperty("202")
    // Write-method errors (body validation, not-found/disabled, concurrency).
    expect(op?.responses).toHaveProperty("400")
    expect(op?.responses).toHaveProperty("404")
    expect(op?.responses).toHaveProperty("429")
  })

  it("does not emit body/concurrency error codes on the GET list route", () => {
    const op = buildSpec().paths["/api/v1/assistants"]?.get
    expect(op).toBeDefined()
    // A GET has no request body and no per-resource id/concurrency path.
    expect(op?.responses).not.toHaveProperty("400")
    expect(op?.responses).not.toHaveProperty("404")
    expect(op?.responses).not.toHaveProperty("429")
  })
})
