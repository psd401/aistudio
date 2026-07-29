"use client"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { McpAuthType, McpToolSource } from "@/lib/mcp/connector-types"
import type { ConnectorFormValues } from "./connector-form-state"

export type UpdateConnectorField = <K extends keyof ConnectorFormValues>(
  field: K,
  value: ConnectorFormValues[K]
) => void

interface BasicConnectorFieldsProps {
  form: ConnectorFormValues
  setError: (error: string | null) => void
  updateField: UpdateConnectorField
}

export function BasicConnectorFields({
  form,
  setError,
  updateField,
}: BasicConnectorFieldsProps) {
  return (
    <>
      <div>
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={form.name}
          onChange={(event) => updateField("name", event.target.value)}
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
          value={form.url}
          onChange={(event) => updateField("url", event.target.value)}
          placeholder="https://mcp.canva.com/mcp"
          required
        />
      </div>
      <div>
        <Label>Transport</Label>
        <Select
          value={form.transport}
          onValueChange={(value) =>
            updateField(
              "transport",
              value as ConnectorFormValues["transport"]
            )
          }
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
          value={form.authType}
          onValueChange={(value) => {
            updateField("authType", value as McpAuthType)
            if (value === "none" || value === "cognito_passthrough") {
              setError(null)
            }
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
            <SelectItem value="cognito_passthrough">
              Cognito Passthrough
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  )
}

interface OAuthConnectorFieldsProps {
  form: ConnectorFormValues
  hasExistingCredentials: boolean
  updateField: UpdateConnectorField
}

export function OAuthConnectorFields({
  form,
  hasExistingCredentials,
  updateField,
}: OAuthConnectorFieldsProps) {
  return (
    <>
      <div>
        <Label>Tool Source</Label>
        <Select
          value={form.toolSource}
          onValueChange={(value) =>
            updateField("toolSource", value as McpToolSource)
          }
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
          {form.toolSource === "custom"
            ? "Uses built-in tool definitions that call the provider’s REST API directly."
            : "Fetches tool definitions from the MCP server at runtime."}
        </p>
      </div>
      <div className="rounded-md border border-border bg-muted/50 p-3">
        <p className="text-xs text-muted-foreground">
          {form.oauthClientId.trim() || hasExistingCredentials
            ? "Uses pre-registered OAuth credentials. Required for providers like Canva that restrict redirect URIs to pre-configured values."
            : "Users authenticate directly with the service when connecting. The MCP protocol handles client registration automatically."}
        </p>
      </div>
      <div>
        <Label htmlFor="oauthClientId">Client ID</Label>
        <Input
          id="oauthClientId"
          value={form.oauthClientId}
          onChange={(event) =>
            updateField("oauthClientId", event.target.value)
          }
          placeholder="OAuth client ID"
        />
      </div>
      <div>
        <Label htmlFor="oauthClientSecret">Client Secret</Label>
        <Input
          id="oauthClientSecret"
          type="password"
          value={form.oauthClientSecret}
          onChange={(event) =>
            updateField("oauthClientSecret", event.target.value)
          }
          placeholder={
            hasExistingCredentials
              ? "Leave blank to keep existing"
              : "OAuth client secret"
          }
        />
      </div>
      <div>
        <Label htmlFor="oauthAuthEndpoint">Authorization Endpoint URL</Label>
        <Input
          id="oauthAuthEndpoint"
          type="url"
          value={form.oauthAuthEndpoint}
          onChange={(event) =>
            updateField("oauthAuthEndpoint", event.target.value)
          }
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
          value={form.oauthTokenEndpoint}
          onChange={(event) =>
            updateField("oauthTokenEndpoint", event.target.value)
          }
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
          value={form.oauthScopes}
          onChange={(event) => updateField("oauthScopes", event.target.value)}
          placeholder="design:content:read design:content:write"
          rows={2}
        />
        <p className="text-xs text-muted-foreground mt-1">
          Optional. Space-separated OAuth scopes.
        </p>
      </div>
      {hasExistingCredentials && (
        <div className="flex items-center space-x-2">
          <Checkbox
            id="clearOAuthCredentials"
            checked={form.clearOAuthCredentials}
            onCheckedChange={(checked) =>
              updateField("clearOAuthCredentials", checked === true)
            }
          />
          <Label
            htmlFor="clearOAuthCredentials"
            className="text-sm font-normal"
          >
            Clear stored credentials
          </Label>
        </div>
      )}
    </>
  )
}

export function AuthSpecificFields({
  form,
  updateField,
}: {
  form: ConnectorFormValues
  updateField: UpdateConnectorField
}) {
  if (form.authType === "cognito_passthrough") {
    return (
      <div className="rounded-md border border-border bg-muted/50 p-3">
        <p className="text-xs text-muted-foreground">
          The user&apos;s Cognito ID token is forwarded as a Bearer token. No
          per-user token storage needed — the token comes from the active
          session. The MCP server must trust this Cognito pool&apos;s JWKS for
          JWT validation.
        </p>
      </div>
    )
  }
  if (form.authType !== "api_key" && form.authType !== "jwt") return null

  return (
    <div>
      <Label htmlFor="credentialsKey">
        Credential Profile <span className="text-destructive">*</span>
      </Label>
      <Input
        id="credentialsKey"
        value={form.credentialsKey}
        onChange={(event) => updateField("credentialsKey", event.target.value)}
        placeholder="Server-configured profile id"
        maxLength={255}
        required
      />
      <p className="text-xs text-muted-foreground mt-1">
        Opaque profile configured by the deployment and bound to this provider
        origin
      </p>
    </div>
  )
}

interface ConnectorSubmitFieldsProps {
  error: string | null
  form: ConnectorFormValues
  isEditing: boolean
  isSubmitting: boolean
  updateField: UpdateConnectorField
}

export function ConnectorSubmitFields({
  error,
  form,
  isEditing,
  isSubmitting,
  updateField,
}: ConnectorSubmitFieldsProps) {
  const action = isEditing ? "Update Connector" : "Create Connector"
  const pendingAction = isEditing ? "Updating..." : "Creating..."

  return (
    <>
      <div>
        <Label htmlFor="maxConnections">Max Connections (1–100)</Label>
        <Input
          id="maxConnections"
          type="number"
          min="1"
          max="100"
          value={form.maxConnections}
          onChange={(event) =>
            updateField("maxConnections", event.target.value)
          }
        />
      </div>
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}
      <Button
        type="submit"
        disabled={isSubmitting || !form.name || !form.url}
        className="w-full"
      >
        {isSubmitting ? pendingAction : action}
      </Button>
    </>
  )
}
