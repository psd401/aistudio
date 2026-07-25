/**
 * OAuth Authorization Consent Page
 * Displays consent screen for OAuth2 authorization requests.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import { redirect } from "next/navigation"
import { headers } from "next/headers"
import { ConsentForm } from "./_components/consent-form"
import { getScopeLabel } from "@/lib/oauth/oauth-scopes"
import { getOAuthInteractionSummary } from "@/lib/oauth/interaction-service"

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

  const interaction = await getOAuthInteractionSummary(
    uid,
    new Headers(await headers())
  ).catch(() => undefined)

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

  if (interaction.promptName === "login") {
    redirect(
      `/oauth/authorize/interaction/${encodeURIComponent(uid)}/login`
    )
  }

  if (interaction.promptName !== "consent") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="max-w-md p-6 text-center">
          <h1 className="text-xl font-semibold text-gray-900">
            Authorization Cannot Continue
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This authorization request requires an unsupported interaction.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg border bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Authorize Application</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          <strong>{interaction.clientName}</strong> is requesting access to
          your AI Studio account.
        </p>

        <div className="mt-6">
          <h2 className="text-sm font-medium text-gray-700">Requested permissions:</h2>
          <ul className="mt-2 space-y-1">
            {interaction.requestedScopes.map((scope) => (
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

        <ConsentForm uid={uid} />
      </div>
    </div>
  )
}

function scopeLabel(scope: string): string {
  return getScopeLabel(scope)
}
