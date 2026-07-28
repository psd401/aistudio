export interface ProviderTokens {
  access_token: string
  token_type: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

export function parsePreRegisteredTokens(
  value: unknown
): ProviderTokens | null {
  if (!value || typeof value !== "object") return null
  const tokens = value as Record<string, unknown>
  if (
    typeof tokens.access_token !== "string" ||
    typeof tokens.token_type !== "string"
  ) {
    return null
  }
  return {
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    refresh_token:
      typeof tokens.refresh_token === "string"
        ? tokens.refresh_token
        : undefined,
    expires_in:
      typeof tokens.expires_in === "number" ? tokens.expires_in : undefined,
    scope: typeof tokens.scope === "string" ? tokens.scope : undefined,
  }
}
