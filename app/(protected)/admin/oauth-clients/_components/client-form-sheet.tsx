/**
 * OAuth Client Registration Form
 * Sheet form for creating new OAuth2 clients.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createOAuthClient } from "@/actions/oauth/oauth-client.actions"
import { API_SCOPES } from "@/lib/api-keys/scopes"
import {
  getScopeLabel,
  OIDC_SCOPES,
  PUBLIC_CLIENT_REQUIRED_OIDC_SCOPES,
  withPublicClientRequiredScopes,
} from "@/lib/oauth/oauth-scopes"
import type { OAuthApplicationType } from "@/lib/oauth/redirect-uri-policy"

// ============================================
// Props
// ============================================

interface Props {
  onSuccess: () => void
}

// ============================================
// Available Scopes
// ============================================

const OIDC_SCOPE_OPTIONS = OIDC_SCOPES.map(
  (scope) => [scope, getScopeLabel(scope)] as const
)

const MCP_SCOPES = Object.entries(API_SCOPES).filter(([key]) =>
  key.startsWith("mcp:")
)

const OTHER_SCOPES = Object.entries(API_SCOPES).filter(
  ([key]) => !key.startsWith("mcp:")
)

const REQUIRED_PUBLIC_SCOPE_SET = new Set<string>(
  PUBLIC_CLIENT_REQUIRED_OIDC_SCOPES
)

// ============================================
// Component
// ============================================

export function ClientFormSheet({ onSuccess }: Props) {
  const [clientName, setClientName] = useState("")
  const [applicationType, setApplicationType] =
    useState<OAuthApplicationType>("web")
  const [redirectUri, setRedirectUri] = useState("")
  const [authMethod, setAuthMethod] = useState<"none" | "client_secret_post">("none")
  const [selectedScopes, setSelectedScopes] = useState<string[]>(() =>
    withPublicClientRequiredScopes([])
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const [createdClientId, setCreatedClientId] = useState<string | null>(null)

  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setIsSubmitting(true)
    setError(null)

    try {
      const redirectUris = redirectUri
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean)

      const result = await createOAuthClient({
        clientName,
        applicationType,
        redirectUris,
        allowedScopes: selectedScopes,
        tokenEndpointAuthMethod: authMethod,
      })

      if (result.isSuccess && result.data) {
        if (result.data.clientSecret) {
          setCreatedSecret(result.data.clientSecret)
          setCreatedClientId(result.data.client.clientId)
        } else {
          setCreatedClientId(result.data.client.clientId)
          onSuccess()
        }
      } else {
        setError(result.message || "Failed to create OAuth client")
      }
    } catch {
      setError("An unexpected error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  // Show the secret if just created
  if (createdSecret) {
    return (
      <div className="mt-6 space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-800">
            Client secret created — copy it now. It cannot be shown again.
          </p>
        </div>
        <div>
          <Label>Client ID</Label>
          <code className="block mt-1 text-xs bg-muted p-2 rounded break-all">
            {createdClientId}
          </code>
        </div>
        <div>
          <Label>Client Secret</Label>
          <code className="block mt-1 text-xs bg-muted p-2 rounded break-all">
            {createdSecret}
          </code>
        </div>
        <Button onClick={onSuccess} className="w-full">
          Done
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-4">
      <div>
        <Label htmlFor="clientName">Client Name</Label>
        <Input
          id="clientName"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          placeholder="My MCP Application"
          required
        />
      </div>

      <div>
        <Label htmlFor="applicationType">Application Type</Label>
        <Select
          value={applicationType}
          onValueChange={(value) => {
            const nextType = value as OAuthApplicationType
            setApplicationType(nextType)
            if (nextType !== "web") {
              setAuthMethod("none")
              setSelectedScopes((scopes) =>
                withPublicClientRequiredScopes(scopes)
              )
            }
          }}
        >
          <SelectTrigger id="applicationType">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="web">Web application</SelectItem>
            <SelectItem value="browser_extension">
              Browser extension
            </SelectItem>
            <SelectItem value="native">Native application</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          {applicationType === "web"
            ? "Hosted HTTPS application; may use a client secret."
            : applicationType === "browser_extension"
              ? "Public Chromium extension using its exact chromiumapp.org callback."
              : "Public desktop or mobile app using claimed HTTPS, a reverse-domain scheme, or a literal loopback callback."}
        </p>
      </div>

      <div>
        <Label htmlFor="redirectUri">Redirect URI(s)</Label>
        <Input
          id="redirectUri"
          value={redirectUri}
          onChange={(e) => setRedirectUri(e.target.value)}
          placeholder={
            applicationType === "web"
              ? "https://app.example.org/oauth/callback"
              : applicationType === "browser_extension"
                ? "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/atrium"
                : "com.example.app:/oauth/callback, http://127.0.0.1/callback"
          }
          required
        />
        <p className="text-xs text-muted-foreground mt-1">
          Comma-separated exact callbacks. Fragments, userinfo, wildcards, and
          localhost are rejected.
        </p>
      </div>

      <div>
        <Label htmlFor="authMethod">Auth Method</Label>
        <Select
          value={authMethod}
          disabled={applicationType !== "web"}
          onValueChange={(v) => {
            const nextAuthMethod = v as "none" | "client_secret_post"
            setAuthMethod(nextAuthMethod)
            if (nextAuthMethod === "none") {
              setSelectedScopes((scopes) =>
                withPublicClientRequiredScopes(scopes)
              )
            }
          }}
        >
          <SelectTrigger id="authMethod">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Public (PKCE only)</SelectItem>
            <SelectItem value="client_secret_post">
              Confidential (client secret)
            </SelectItem>
          </SelectContent>
        </Select>
        {applicationType !== "web" && (
          <p className="text-xs text-muted-foreground mt-1">
            Browser-extension and native apps cannot keep a secret; S256 PKCE
            is mandatory.
          </p>
        )}
      </div>

      <div>
        <Label className="mb-2 block">OIDC Scopes</Label>
        <div className="space-y-2">
          {OIDC_SCOPE_OPTIONS.map(([scope, description]) => {
            const isRequiredPublicScope =
              authMethod === "none" && REQUIRED_PUBLIC_SCOPE_SET.has(scope)

            return (
              <label
                key={scope}
                className="flex items-center gap-2 text-sm cursor-pointer"
              >
                <Checkbox
                  checked={selectedScopes.includes(scope)}
                  disabled={isRequiredPublicScope}
                  onCheckedChange={() => toggleScope(scope)}
                />
                <span className="font-mono text-xs">{scope}</span>
                <span className="text-muted-foreground">
                  — {description}
                  {isRequiredPublicScope ? " (required for public clients)" : ""}
                </span>
              </label>
            )
          })}
        </div>
      </div>

      <div>
        <Label className="mb-2 block">MCP Scopes</Label>
        <div className="space-y-2 max-h-40 overflow-y-auto">
          {MCP_SCOPES.map(([scope, description]) => (
            <label
              key={scope}
              className="flex items-center gap-2 text-sm cursor-pointer"
            >
              <Checkbox
                checked={selectedScopes.includes(scope)}
                onCheckedChange={() => toggleScope(scope)}
              />
              <span className="font-mono text-xs">{scope}</span>
              <span className="text-muted-foreground">— {description}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <Label className="mb-2 block">API Scopes</Label>
        <div className="space-y-2 max-h-40 overflow-y-auto">
          {OTHER_SCOPES.map(([scope, description]) => (
            <label
              key={scope}
              className="flex items-center gap-2 text-sm cursor-pointer"
            >
              <Checkbox
                checked={selectedScopes.includes(scope)}
                onCheckedChange={() => toggleScope(scope)}
              />
              <span className="font-mono text-xs">{scope}</span>
              <span className="text-muted-foreground">— {description}</span>
            </label>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <Button type="submit" disabled={isSubmitting || !clientName} className="w-full">
        {isSubmitting ? "Creating..." : "Create Client"}
      </Button>
    </form>
  )
}
