/**
 * Canva Brand Template Tools
 *
 * Tools for working with Canva brand templates and autofill.
 * Note: Brand template endpoints may require Canva Enterprise access.
 *
 * @see https://www.canva.dev/docs/connect/endpoints/brand-templates/
 */

import { z } from "zod"
import type { CanvaApiClient } from "../canva-api-client"
import { canvaTool } from "../tool-helper"

const listBrandTemplatesSchema = z.object({
  query: z.string().optional().describe("Search query to filter templates by title"),
  continuation: z.string().optional().describe("Pagination token from a previous response"),
})

const getBrandTemplateSchema = z.object({
  brand_template_id: z.string().describe("The brand template ID"),
})

const getTemplateDatasetSchema = z.object({
  brand_template_id: z.string().describe("The brand template ID"),
})

const autofillTemplateSchema = z.object({
  brand_template_id: z.string().describe("The brand template ID"),
  title: z.string().optional().describe("Title for the new autofilled design"),
  data: z
    .record(
      z.string(),
      z.object({
        type: z.enum(["text", "image"]).describe("Field type: text or image"),
        text: z.string().optional().describe("Text value (for text fields)"),
        asset_id: z.string().optional().describe("Canva asset ID (for image fields)"),
      })
    )
    .describe("Map of field names to values. Get field names from canva_get_template_dataset."),
})

/** @returns Record of AI SDK tool definitions */
export function createBrandTemplateTools(client: CanvaApiClient): Record<string, unknown> {
  return {
    canva_list_brand_templates: canvaTool({
      description:
        "List available brand templates in the Canva account. " +
        "Returns template IDs, titles, and thumbnails. " +
        "May require Canva Enterprise access.",
      parameters: listBrandTemplatesSchema,
      execute: async (args) => {
        const params: Record<string, string> = {}
        if (args.query) params.query = args.query
        if (args.continuation) params.continuation = args.continuation
        return client.get("/v1/brand-templates", params)
      },
    }),

    canva_get_brand_template: canvaTool({
      description:
        "Get details of a specific brand template by ID. Returns title, " +
        "thumbnail, page count, and metadata.",
      parameters: getBrandTemplateSchema,
      execute: async ({ brand_template_id }) => {
        return client.get(`/v1/brand-templates/${brand_template_id}`)
      },
    }),

    canva_get_template_dataset: canvaTool({
      description:
        "Get the autofillable fields (dataset) for a brand template. " +
        "Returns field names, types, and current values. Use this to " +
        "understand what data can be injected before calling autofill.",
      parameters: getTemplateDatasetSchema,
      execute: async ({ brand_template_id }) => {
        return client.get(`/v1/brand-templates/${brand_template_id}/dataset`)
      },
    }),

    canva_autofill_template: canvaTool({
      description:
        "Create a new design by autofilling a brand template with data. " +
        "Provide field values matching the template dataset. This is an " +
        "async operation — the tool polls until the design is created. " +
        "Returns the new design ID and edit URL.",
      parameters: autofillTemplateSchema,
      execute: async (args) => {
        const body: Record<string, unknown> = {
          brand_template_id: args.brand_template_id,
          data: args.data,
        }
        if (args.title) body.title = args.title
        return client.startAndPollJob("/v1/autofills", "/v1/autofills", body)
      },
    }),
  }
}
