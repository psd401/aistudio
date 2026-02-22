/**
 * Canva Folder Tools
 *
 * Tools for managing Canva folders via the Connect API.
 */

import { z } from "zod"
import type { CanvaApiClient } from "../canva-api-client"
import { canvaTool } from "../tool-helper"

const listFolderItemsSchema = z.object({
  folder_id: z.string().describe("The Canva folder ID"),
  continuation: z.string().optional().describe("Pagination token from a previous response"),
  sort_by: z.enum(["modified_descending", "modified_ascending", "title_ascending", "title_descending"]).optional().describe("Sort order for results"),
})

const createFolderSchema = z.object({
  name: z.string().describe("Name for the new folder"),
  parent_folder_id: z.string().optional().describe("Parent folder ID (omit for root level)"),
})

/** @returns Record of AI SDK tool definitions */
export function createFolderTools(client: CanvaApiClient): Record<string, unknown> {
  return {
    canva_list_folder_items: canvaTool({
      description:
        "List items (designs, folders, images) in a Canva folder. " +
        "Results are paginated — use the continuation token for more results.",
      inputSchema: listFolderItemsSchema,
      execute: async (args) => {
        const params: Record<string, string> = {}
        if (args.continuation) params.continuation = args.continuation
        if (args.sort_by) params.sort_by = args.sort_by
        return client.get(`/v1/folders/${args.folder_id}/items`, params)
      },
    }),

    canva_create_folder: canvaTool({
      description: "Create a new folder in Canva.",
      inputSchema: createFolderSchema,
      execute: async (args) => {
        const body: Record<string, unknown> = { name: args.name }
        if (args.parent_folder_id) body.parent_folder_id = args.parent_folder_id
        return client.post("/v1/folders", body)
      },
    }),
  }
}
