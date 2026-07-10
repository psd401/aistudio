/**
 * Unit tests for Canva tool path-parameter encoding — REV-COR-625.
 *
 * LLM-supplied IDs interpolated into Canva request paths must be wrapped in
 * encodeURIComponent so an ID like "../brand-templates/secret" cannot escape its
 * intended path segment (`/` → %2F, so `new URL()` keeps it in-segment rather than
 * normalizing away a `..`). Query-param handling is unaffected.
 */

// AI SDK v6 `tool()` is an identity pass-through — stub it so `.execute` is the
// exact function defined in each tool module.
jest.mock("ai", () => ({ tool: (config: unknown) => config }))

import { createAssetTools } from "@/lib/mcp/custom-tools/canva/tools/asset-tools"
import { createDesignTools } from "@/lib/mcp/custom-tools/canva/tools/design-tools"
import { createFolderTools } from "@/lib/mcp/custom-tools/canva/tools/folder-tools"
import { createBrandTemplateTools } from "@/lib/mcp/custom-tools/canva/tools/brand-template-tools"
import type { CanvaApiClient } from "@/lib/mcp/custom-tools/canva/canva-api-client"

interface ExecTool {
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

function mockClient() {
  return {
    get: jest.fn().mockResolvedValue({}),
    post: jest.fn().mockResolvedValue({}),
    startAndPollJob: jest.fn().mockResolvedValue({}),
  }
}

/** An ID crafted to break out of its path segment if left unencoded. */
const ESCAPE_ID = "../brand-templates/secret"
const ENCODED_ESCAPE = encodeURIComponent(ESCAPE_ID) // "..%2Fbrand-templates%2Fsecret"

describe("Canva tool path-parameter encoding (REV-COR-625)", () => {
  it("canva_get_asset encodes asset_id", async () => {
    const client = mockClient()
    const tools = createAssetTools(client as unknown as CanvaApiClient) as Record<
      string,
      ExecTool
    >

    await tools.canva_get_asset.execute({ asset_id: ESCAPE_ID })

    expect(client.get).toHaveBeenCalledWith(`/v1/assets/${ENCODED_ESCAPE}`)
    // The literal "../" (unencoded traversal) must not appear in the path.
    expect(client.get.mock.calls[0][0]).not.toContain("../")
  })

  it("canva_get_design encodes design_id", async () => {
    const client = mockClient()
    const tools = createDesignTools(client as unknown as CanvaApiClient) as Record<
      string,
      ExecTool
    >

    await tools.canva_get_design.execute({ design_id: ESCAPE_ID })

    expect(client.get).toHaveBeenCalledWith(`/v1/designs/${ENCODED_ESCAPE}`)
    expect(client.get.mock.calls[0][0]).not.toContain("../")
  })

  it("canva_list_folder_items encodes folder_id (query params preserved)", async () => {
    const client = mockClient()
    const tools = createFolderTools(client as unknown as CanvaApiClient) as Record<
      string,
      ExecTool
    >

    await tools.canva_list_folder_items.execute({ folder_id: ESCAPE_ID })

    expect(client.get).toHaveBeenCalledWith(
      `/v1/folders/${ENCODED_ESCAPE}/items`,
      {}
    )
    expect(client.get.mock.calls[0][0]).not.toContain("../")
  })

  it("canva_get_brand_template encodes brand_template_id", async () => {
    const client = mockClient()
    const tools = createBrandTemplateTools(
      client as unknown as CanvaApiClient
    ) as Record<string, ExecTool>

    await tools.canva_get_brand_template.execute({ brand_template_id: ESCAPE_ID })

    expect(client.get).toHaveBeenCalledWith(`/v1/brand-templates/${ENCODED_ESCAPE}`)
    expect(client.get.mock.calls[0][0]).not.toContain("../")
  })

  it("canva_get_template_dataset encodes brand_template_id in the dataset path", async () => {
    const client = mockClient()
    const tools = createBrandTemplateTools(
      client as unknown as CanvaApiClient
    ) as Record<string, ExecTool>

    await tools.canva_get_template_dataset.execute({ brand_template_id: ESCAPE_ID })

    expect(client.get).toHaveBeenCalledWith(
      `/v1/brand-templates/${ENCODED_ESCAPE}/dataset`
    )
    expect(client.get.mock.calls[0][0]).not.toContain("../")
  })

  it("leaves a normal alphanumeric ID unchanged", async () => {
    const client = mockClient()
    const tools = createAssetTools(client as unknown as CanvaApiClient) as Record<
      string,
      ExecTool
    >

    await tools.canva_get_asset.execute({ asset_id: "AbC123-_" })

    // encodeURIComponent leaves unreserved chars (alnum, -, _) untouched.
    expect(client.get).toHaveBeenCalledWith("/v1/assets/AbC123-_")
  })
})
