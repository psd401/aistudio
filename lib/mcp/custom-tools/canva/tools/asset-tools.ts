/**
 * Canva Asset Tools
 *
 * Tools for managing Canva assets (images, videos, etc.)
 * via the Connect API.
 */

import { z } from "zod"
import type { CanvaApiClient } from "../canva-api-client"
import { canvaTool } from "../tool-helper"

const getAssetSchema = z.object({
  asset_id: z.string().describe("The Canva asset ID"),
})

const uploadAssetSchema = z.object({
  url: z.string().url().describe("Publicly accessible URL of the file to upload"),
  name: z.string().optional().describe("Display name for the asset in Canva"),
})

/** @returns Record of AI SDK tool definitions */
export function createAssetTools(client: CanvaApiClient): Record<string, unknown> {
  return {
    canva_get_asset: canvaTool({
      description:
        "Get metadata for a specific Canva asset by ID. Returns name, " +
        "type, thumbnail URL, dimensions, and tags.",
      parameters: getAssetSchema,
      execute: async ({ asset_id }) => {
        return client.get(`/v1/assets/${asset_id}`)
      },
    }),

    canva_upload_asset: canvaTool({
      description:
        "Upload an asset (image, video) to Canva from a publicly accessible URL. " +
        "This is an async operation — the tool polls until upload completes.",
      parameters: uploadAssetSchema,
      execute: async (args) => {
        const body: Record<string, unknown> = {
          upload_data: { type: "url", url: args.url },
        }
        if (args.name) body.name = args.name
        return client.startAndPollJob(
          "/v1/asset-uploads",
          "/v1/asset-uploads",
          body
        )
      },
    }),
  }
}
