/**
 * OAuth Authorization Consent Page
 * Displays consent screen for OAuth2 authorization requests.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import { redirect } from "next/navigation"
import { ConsentForm } from "./_components/consent-form"
import { getScopeLabel } from "@/lib/oauth/oauth-scopes"

interface OAuthAuthorizePageProps {
  searchParams: Promise<{ uid?: string }>
}

export default async function OAuthAuthorizePage({
  searchParams,
}: OAuthAuthorizePageProps) {
  const params = await searchParams
  const uid = params.uid

  if (!uid) {
    redirect("/")
  }

  // Fetch interaction details from oidc-provider
  let interaction: {
    prompt: { name: string; details?: Record<string, unknown> }
    params: Record<string, unknown>
  } | null = null

  try {
    const { getOidcProvider } = await import("@/lib/oauth/oidc-provider-config")
    const provider = await getOidcProvider()
    const details = await provider.Interaction.find(uid)

    if (details) {
      interaction = {
        prompt: details.prompt as { name: string; details?: Record<string, unknown> },
        params: details.params as Record<string, unknown>,
      }
    }
  } catch {
    // Interaction may have expired
  }

  if (!interaction) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="max-w-md p-6 text-center">
          <h1 className="text-xl font-semibold text-gray-900">Authorization Expired</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This authorization request has expired. Please try again.
          </p>
        </div>
      </div>
    )
  }

  const clientId = interaction.params.client_id as string
  const requestedScopes = ((interaction.params.scope as string) ?? "openid").split(" ")

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg border bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Authorize Application</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          <strong>{clientId}</strong> is requesting access to your AI Studio account.
        </p>

        <div className="mt-6">
          <h2 className="text-sm font-medium text-gray-700">Requested permissions:</h2>
          <ul className="mt-2 space-y-1">
            {requestedScopes.map((scope) => (
              <li
                key={scope}
                className="flex items-center gap-2 text-sm text-gray-600"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                {scopeLabel(scope)}
              </li>
            ))}
          </ul>
        </div>

        <ConsentForm uid={uid} scopes={requestedScopes} />
      </div>
    </div>
  )
}

function scopeLabel(scope: string): string {
  return getScopeLabel(scope)
}
