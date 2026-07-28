import type { McpServerWithStats } from "@/actions/admin/connector.actions"
import type { McpAuthType, McpToolSource } from "@/lib/mcp/connector-types"

export interface ConnectorFormValues {
  authType: McpAuthType
  clearOAuthCredentials: boolean
  credentialsKey: string
  maxConnections: string
  name: string
  oauthAuthEndpoint: string
  oauthClientId: string
  oauthClientSecret: string
  oauthScopes: string
  oauthTokenEndpoint: string
  toolSource: McpToolSource
  transport: "http" | "stdio" | "websocket"
  url: string
}

export interface OAuthCredentialsInput {
  authorizationEndpointUrl?: string
  clientId: string
  clientSecret: string
  scopes?: string
  tokenEndpointUrl?: string
}

export function initialConnectorForm(
  server: McpServerWithStats | null
): ConnectorFormValues {
  return {
    authType: (server?.authType as McpAuthType) ?? "none",
    clearOAuthCredentials: false,
    credentialsKey: server?.credentialsKey ?? "",
    maxConnections: String(server?.maxConnections ?? 10),
    name: server?.name ?? "",
    oauthAuthEndpoint: "",
    oauthClientId: "",
    oauthClientSecret: "",
    oauthScopes: "",
    oauthTokenEndpoint: "",
    toolSource: (server?.toolSource as McpToolSource) ?? "mcp",
    transport:
      (server?.transport as "http" | "stdio" | "websocket") ?? "http",
    url: server?.url ?? "",
  }
}

type ValidationResult =
  | { valid: true; maxConnections: number }
  | { valid: false; error: string }

export function validateConnectorForm(
  form: ConnectorFormValues,
  isEditing: boolean
): ValidationResult {
  if (
    (form.authType === "api_key" || form.authType === "jwt") &&
    !form.credentialsKey.trim()
  ) {
    return {
      valid: false,
      error: "Credentials Key is required for API Key and JWT auth types.",
    }
  }
  if (
    form.authType === "oauth" &&
    form.oauthClientId.trim() &&
    !isEditing &&
    !form.oauthClientSecret.trim()
  ) {
    return {
      valid: false,
      error: "Client Secret is required when setting OAuth credentials.",
    }
  }

  const maxConnections = Number.parseInt(form.maxConnections, 10)
  if (
    !Number.isInteger(maxConnections) ||
    maxConnections < 1 ||
    maxConnections > 100
  ) {
    return {
      valid: false,
      error: "Max Connections must be between 1 and 100.",
    }
  }
  return { valid: true, maxConnections }
}

export function buildOAuthCredentials(
  form: ConnectorFormValues,
  isEditing: boolean
): OAuthCredentialsInput | null | undefined {
  if (form.authType !== "oauth") return undefined
  if (form.clearOAuthCredentials) return null
  if (!form.oauthClientId.trim()) return undefined
  if (isEditing && !form.oauthClientSecret.trim()) return undefined

  return {
    clientId: form.oauthClientId.trim(),
    clientSecret: form.oauthClientSecret,
    authorizationEndpointUrl: form.oauthAuthEndpoint.trim() || undefined,
    tokenEndpointUrl: form.oauthTokenEndpoint.trim() || undefined,
    scopes: form.oauthScopes.trim() || undefined,
  }
}
