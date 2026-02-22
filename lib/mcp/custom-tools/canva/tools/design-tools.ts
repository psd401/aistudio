/**
 * Canva Design Tools
 *
 * Tools for listing, creating, and exporting Canva designs
 * via the Connect API.
 */

import { z } from "zod"
import type { CanvaApiClient } from "../canva-api-client"
import { canvaTool } from "../tool-helper"

const listDesignsSchema = z.object({
  query: z.string().optional().describe("Search query to filter designs by title"),
  continuation: z.string().optional().describe("Pagination token from a previous response"),
  ownership: z.enum(["any", "owned", "shared"]).optional().describe("Filter by ownership type"),
  sort_by: z.enum(["relevance", "modified_descending", "modified_ascending", "title_ascending", "title_descending"]).optional().describe("Sort order for results"),
})

const getDesignSchema = z.object({
  design_id: z.string().describe("The Canva design ID"),
})

const createDesignSchema = z.object({
  design_type: z.string().optional().describe("Design type preset (e.g., 'Presentation', 'Poster', 'A4Document', 'InstagramPost')"),
  title: z.string().optional().describe("Title for the new design"),
  width: z.number().int().optional().describe("Custom width in pixels (use instead of design_type)"),
  height: z.number().int().optional().describe("Custom height in pixels (use instead of design_type)"),
})

const exportDesignSchema = z.object({
  design_id: z.string().describe("The Canva design ID to export"),
  format: z.enum(["pdf", "png", "jpg", "gif", "pptx", "mp4"]).describe("Export file format"),
  quality: z.enum(["regular", "pro"]).optional().describe("Export quality tier"),
  pages: z.array(z.number().int()).optional().describe("Specific page numbers to export (1-indexed)"),
})

const importDesignSchema = z.object({
  url: z.string().url().describe("Publicly accessible URL of the file to import"),
  title: z.string().optional().describe("Title for the imported design"),
})

/** @returns Record of AI SDK tool definitions */
export function createDesignTools(client: CanvaApiClient): Record<string, unknown> {
  return {
    canva_list_designs: canvaTool({
      description:
        "Search and list Canva designs. Returns design IDs, titles, thumbnails, and metadata. " +
        "Use query parameter to filter by title. Results are paginated.",
      inputSchema: listDesignsSchema,
      execute: async (args) => {
        const params: Record<string, string> = {}
        if (args.query) params.query = args.query
        if (args.continuation) params.continuation = args.continuation
        if (args.ownership) params.ownership = args.ownership
        if (args.sort_by) params.sort_by = args.sort_by
        return client.get("/v1/designs", params)
      },
    }),

    canva_get_design: canvaTool({
      description:
        "Get details of a specific Canva design by ID. Returns title, owner, " +
        "thumbnail URL, page count, and timestamps.",
      inputSchema: getDesignSchema,
      execute: async ({ design_id }) => {
        return client.get(`/v1/designs/${design_id}`)
      },
    }),

    canva_create_design: canvaTool({
      description:
        "Create a new Canva design. Specify either a design_type preset " +
        "(e.g., 'Presentation', 'Poster') or custom dimensions in pixels. " +
        "Returns the new design ID and edit URL.",
      inputSchema: createDesignSchema,
      execute: async (args) => {
        const body: Record<string, unknown> = {}
        if (args.title) body.title = args.title
        if (args.design_type) {
          body.design_type = { type: args.design_type }
        } else if (args.width && args.height) {
          body.design_type = {
            type: "custom",
            width: args.width,
            height: args.height,
          }
        }
        return client.post("/v1/designs", body)
      },
    }),

    canva_export_design: canvaTool({
      description:
        "Export a Canva design to a file format (PDF, PNG, JPG, etc.). " +
        "This is an async operation — the tool polls until export completes " +
        "and returns download URLs. Exports expire after a short period.",
      inputSchema: exportDesignSchema,
      execute: async (args) => {
        const body: Record<string, unknown> = {
          design_id: args.design_id,
          format: { type: args.format },
        }
        if (args.quality) {
          (body.format as Record<string, unknown>).quality = args.quality
        }
        if (args.pages) body.pages = args.pages
        return client.startAndPollJob("/v1/exports", "/v1/exports", body)
      },
    }),

    canva_import_design: canvaTool({
      description:
        "Import an external file (PDF, image, etc.) as a new Canva design. " +
        "Provide a publicly accessible URL to the file. This is an async operation.",
      inputSchema: importDesignSchema,
      execute: async (args) => {
        const body: Record<string, unknown> = {
          import_data: { type: "url", url: args.url },
        }
        if (args.title) body.title = args.title
        return client.startAndPollJob("/v1/imports", "/v1/imports", body)
      },
    }),
  }
}
