"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  createMcpServer,
  updateMcpServer,
  type McpServerWithStats,
} from "@/actions/admin/connector.actions"
import type { McpAuthType, McpToolSource } from "@/lib/mcp/connector-types"

interface Props {
  server: McpServerWithStats | null
  onSuccess: () => void
}

export function ConnectorFormSheet({ server, onSuccess }: Props) {
  const isEditing = !!server

  const [name, setName] = useState(server?.name ?? "")
  const [url, setUrl] = useState(server?.url ?? "")
  const [transport, setTransport] = useState<"http" | "stdio" | "websocket">(
    (server?.transport as "http" | "stdio" | "websocket") ?? "http"
  )
  const [authType, setAuthType] = useState<McpAuthType>(
    (server?.authType as McpAuthType) ?? "none"
  )
  const [toolSource, setToolSource] = useState<McpToolSource>(
    (server?.toolSource as McpToolSource) ?? "mcp"
  )
  const [credentialsKey, setCredentialsKey] = useState(
    server?.credentialsKey ?? ""
  )
  // OAuth credential fields
  const [oauthClientId, setOauthClientId] = useState("")
  const [oauthClientSecret, setOauthClientSecret] = useState("")
  const [oauthAuthEndpoint, setOauthAuthEndpoint] = useState("")
  const [oauthTokenEndpoint, setOauthTokenEndpoint] = useState("")
  const [oauthScopes, setOauthScopes] = useState("")
  const [clearOAuthCredentials, setClearOAuthCredentials] = useState(false)
  const [maxConnections, setMaxConnections] = useState(
    String(server?.maxConnections ?? 10)
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasExistingOAuthCredentials = isEditing && server?.hasOAuthCredentials

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // Validate credentialsKey required for api_key and jwt auth types
    if ((authType === "api_key" || authType === "jwt") && !credentialsKey.trim()) {
      setError("Credentials Key is required for API Key and JWT auth types.")
      return
    }

    // Validate OAuth credentials: if clientId is provided, clientSecret is required on create
    if (authType === "oauth" && oauthClientId.trim() && !isEditing && !oauthClientSecret.trim()) {
      setError("Client Secret is required when setting OAuth credentials.")
      return
    }

    // Validate maxConnections range
    const maxConn = parseInt(maxConnections, 10)
    if (!Number.isInteger(maxConn) || maxConn < 1 || maxConn > 100) {
      setError("Max Connections must be between 1 and 100.")
      return
    }

    setIsSubmitting(true)

    try {
      // Build OAuth credentials payload if the admin filled in the fields
      let oauthCredentials: {
        clientId: string
        clientSecret: string
        authorizationEndpointUrl?: string
        tokenEndpointUrl?: string
        scopes?: string
      } | null | undefined = undefined

      if (authType === "oauth" && clearOAuthCredentials) {
        // Admin explicitly requested credential removal
        oauthCredentials = null
      } else if (authType === "oauth" && oauthClientId.trim()) {
        if (isEditing && !oauthClientSecret.trim()) {
          // Editing with existing credentials but no new secret — don't send (keeps existing)
          oauthCredentials = undefined
        } else {
          oauthCredentials = {
            clientId: oauthClientId.trim(),
            clientSecret: oauthClientSecret,
            authorizationEndpointUrl: oauthAuthEndpoint.trim() || undefined,
            tokenEndpointUrl: oauthTokenEndpoint.trim() || undefined,
            scopes: oauthScopes.trim() || undefined,
          }
        }
      }

      const commonPayload = {
        name,
        url,
        transport,
        authType,
        toolSource: authType === "oauth" ? toolSource : "mcp" as McpToolSource,
        maxConnections: maxConn,
      }

      const result =
        isEditing && server
          ? await updateMcpServer({
              id: server.id,
              ...commonPayload,
              credentialsKey: credentialsKey || null,
              oauthCredentials,
            })
          : await createMcpServer({
              ...commonPayload,
              credentialsKey: credentialsKey || undefined,
              oauthCredentials: oauthCredentials ?? undefined,
            })

      if (!result.isSuccess) {
        setError(
          result.message ??
            (isEditing ? "Failed to update connector" : "Failed to create connector")
        )
        return
      }

      onSuccess()
    } catch {
      setError("An unexpected error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-4">
      <div>
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Canva"
          maxLength={255}
          required
        />
      </div>

      <div>
        <Label htmlFor="url">URL</Label>
        <Input
          id="url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.canva.com/mcp"
          required
        />
      </div>

      <div>
        <Label>Transport</Label>
        <Select
          value={transport}
          onValueChange={(v) => setTransport(v as "http" | "stdio" | "websocket")}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="http">HTTP</SelectItem>
            <SelectItem value="stdio">Stdio</SelectItem>
            <SelectItem value="websocket">WebSocket</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>Auth Type</Label>
        <Select
          value={authType}
          onValueChange={(v) => {
            setAuthType(v as McpAuthType)
            if (v === "none" || v === "cognito_passthrough") setError(null)
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="oauth">OAuth</SelectItem>
            <SelectItem value="api_key">API Key</SelectItem>
            <SelectItem value="jwt">JWT</SelectItem>
            <SelectItem value="cognito_passthrough">Cognito Passthrough</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {authType === "oauth" && (
        <div>
          <Label>Tool Source</Label>
          <Select
            value={toolSource}
            onValueChange={(v) => setToolSource(v as McpToolSource)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mcp">MCP Server (default)</SelectItem>
              <SelectItem value="custom">Custom (REST API)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            {toolSource === "custom"
              ? "Uses built-in tool definitions that call the provider\u2019s REST API directly."
              : "Fetches tool definitions from the MCP server at runtime."}
          </p>
        </div>
      )}

      {authType === "oauth" && (
        <>
          <div className="rounded-md border border-border bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">
              {oauthClientId.trim() || hasExistingOAuthCredentials
                ? "Uses pre-registered OAuth credentials. Required for providers like Canva that restrict redirect URIs to pre-configured values."
                : "Users authenticate directly with the service when connecting. The MCP protocol handles client registration automatically."}
            </p>
          </div>

          <div>
            <Label htmlFor="oauthClientId">Client ID</Label>
            <Input
              id="oauthClientId"
              value={oauthClientId}
              onChange={(e) => setOauthClientId(e.target.value)}
              placeholder="OAuth client ID"
            />
          </div>

          <div>
            <Label htmlFor="oauthClientSecret">Client Secret</Label>
            <Input
              id="oauthClientSecret"
              type="password"
              value={oauthClientSecret}
              onChange={(e) => setOauthClientSecret(e.target.value)}
              placeholder={hasExistingOAuthCredentials ? "Leave blank to keep existing" : "OAuth client secret"}
            />
          </div>

          <div>
            <Label htmlFor="oauthAuthEndpoint">Authorization Endpoint URL</Label>
            <Input
              id="oauthAuthEndpoint"
              type="url"
              value={oauthAuthEndpoint}
              onChange={(e) => setOauthAuthEndpoint(e.target.value)}
              placeholder="https://provider.com/oauth/authorize"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Optional. Required for providers with custom authorization URLs.
            </p>
          </div>

          <div>
            <Label htmlFor="oauthTokenEndpoint">Token Endpoint URL</Label>
            <Input
              id="oauthTokenEndpoint"
              type="url"
              value={oauthTokenEndpoint}
              onChange={(e) => setOauthTokenEndpoint(e.target.value)}
              placeholder="https://provider.com/oauth/token"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Optional. Required for providers with custom token endpoints.
            </p>
          </div>

          <div>
            <Label htmlFor="oauthScopes">Scopes</Label>
            <Textarea
              id="oauthScopes"
              value={oauthScopes}
              onChange={(e) => setOauthScopes(e.target.value)}
              placeholder="design:content:read design:content:write"
              rows={2}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Optional. Space-separated OAuth scopes.
            </p>
          </div>

          {hasExistingOAuthCredentials && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="clearOAuthCredentials"
                checked={clearOAuthCredentials}
                onCheckedChange={(checked) => setClearOAuthCredentials(checked === true)}
              />
              <Label htmlFor="clearOAuthCredentials" className="text-sm font-normal">
                Clear stored credentials
              </Label>
            </div>
          )}
        </>
      )}

      {authType === "cognito_passthrough" && (
        <div className="rounded-md border border-border bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">
            The user&apos;s Cognito ID token is forwarded as a Bearer token.
            No per-user token storage needed — the token comes from the active session.
            The MCP server must trust this Cognito pool&apos;s JWKS for JWT validation.
          </p>
        </div>
      )}

      {(authType === "api_key" || authType === "jwt") && (
        <div>
          <Label htmlFor="credentialsKey">
            Credentials Key <span className="text-destructive">*</span>
          </Label>
          <Input
            id="credentialsKey"
            value={credentialsKey}
            onChange={(e) => setCredentialsKey(e.target.value)}
            placeholder="AWS Secrets Manager key"
            maxLength={255}
            required
          />
          <p className="text-xs text-muted-foreground mt-1">
            Reference to credentials stored in AWS Secrets Manager
          </p>
        </div>
      )}

      <div>
        <Label htmlFor="maxConnections">Max Connections (1–100)</Label>
        <Input
          id="maxConnections"
          type="number"
          min="1"
          max="100"
          value={maxConnections}
          onChange={(e) => setMaxConnections(e.target.value)}
        />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <Button
        type="submit"
        disabled={isSubmitting || !name || !url}
        className="w-full"
      >
        {isSubmitting
          ? isEditing
            ? "Updating..."
            : "Creating..."
          : isEditing
            ? "Update Connector"
            : "Create Connector"}
      </Button>
    </form>
  )
}
