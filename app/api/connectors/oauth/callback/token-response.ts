import { z } from "zod"
import { ErrorFactories } from "@/lib/error-utils"

const oauthTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z
    .union([
      z.number(),
      z
        .string()
        .transform(value =>
          value !== "" ? Number(value) || undefined : undefined
        ),
    ])
    .optional(),
  scope: z.string().optional(),
})

export type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>

export function parseTokenResponse(json: unknown): OAuthTokenResponse {
  const result = oauthTokenResponseSchema.safeParse(json)
  if (!result.success) {
    throw ErrorFactories.invalidFormat(
      "OAuth token response",
      json,
      result.error.issues[0]?.message ?? "valid token response"
    )
  }
  return result.data
}
