/**
 * Canva Connect API Custom Tool Provider
 *
 * Provides 14 tools covering designs, assets, folders, brand templates,
 * and user info via the Canva Connect REST API.
 *
 * Used when the connector's toolSource is "custom" because Canva's MCP
 * server restricts OAuth redirect URIs to localhost-only hosts, making
 * it unusable for server-side integrations.
 *
 * @see https://www.canva.dev/docs/connect/
 */

import type { ToolSet } from "ai"
import type { CustomToolProvider } from "../types"
import { CanvaApiClient } from "./canva-api-client"
import { createDesignTools } from "./tools/design-tools"
import { createAssetTools } from "./tools/asset-tools"
import { createFolderTools } from "./tools/folder-tools"
import { createBrandTemplateTools } from "./tools/brand-template-tools"
import { createUserTools } from "./tools/user-tools"

function buildTools(accessToken: string): ToolSet {
  const client = new CanvaApiClient(accessToken)

  // Individual tool creators return Record<string, unknown> to avoid AI SDK v6
  // overload inference issues. The spread merges them into a ToolSet-compatible shape.
  return {
    ...createDesignTools(client),
    ...createAssetTools(client),
    ...createFolderTools(client),
    ...createBrandTemplateTools(client),
    ...createUserTools(client),
  } as ToolSet
}

export const canvaProvider: CustomToolProvider = {
  key: "canva",
  urlPatterns: [
    // Anchored patterns prevent evil-canva.com or canva.com.evil.com from matching.
    /^https?:\/\/canva\.com/i,
    /^https?:\/\/[\w-]+\.canva\.com/i,
  ],
  buildTools,
}
