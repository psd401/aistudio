/**
 * Query validation schema for GET /api/v1/assistants.
 * Kept out of route.ts because Next.js route handlers only permit HTTP-method
 * and route-segment-config exports — an extra named export (even for tests)
 * makes `next build` reject the route (REV codex P1, PR #1135).
 */

import { z } from "zod"

export const listQuerySchema = z.object({
  status: z.enum(["draft", "pending_approval", "approved", "rejected", "disabled"]).optional(),
  search: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Opaque assistant-id cursor: validate its numeric shape here so a malformed
  // value (e.g. ?cursor=abc) is a 400 before the DB, not a 500 (REV-SEC-168).
  cursor: z
    .string()
    .regex(/^[1-9]\d*$/, "cursor must be a positive integer")
    .optional(),
})
