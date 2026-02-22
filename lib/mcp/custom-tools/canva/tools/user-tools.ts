/**
 * Canva User Tools
 *
 * Tools for retrieving Canva user information via the Connect API.
 */

import { z } from "zod"
import type { CanvaApiClient } from "../canva-api-client"
import { canvaTool } from "../tool-helper"

const getUserSchema = z.object({})

/** @returns Record of AI SDK tool definitions */
export function createUserTools(client: CanvaApiClient): Record<string, unknown> {
  return {
    canva_get_user: canvaTool({
      description:
        "Get the current authenticated Canva user's profile. Returns " +
        "display name, user ID, and team information.",
      parameters: getUserSchema,
      execute: async () => {
        return client.get("/v1/users/me")
      },
    }),
  }
}
