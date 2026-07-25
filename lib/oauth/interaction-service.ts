/**
 * Read-only access to oidc-provider interactions through its public API.
 */

import "server-only"

import { getOidcProvider } from "./oidc-provider-config"
import { getIssuerUrl } from "./issuer-config"
import { createNodeHttpContext } from "./node-http-adapter"

export interface OAuthInteractionSummary {
  uid: string
  promptName: string
  promptDetails: Record<string, unknown>
  clientId: string
  clientName: string
  requestedScopes: string[]
}

function stringParam(
  params: Record<string, unknown>,
  name: string
): string {
  const value = params[name]
  return typeof value === "string" ? value : ""
}

export async function getOAuthInteractionSummary(
  uid: string,
  requestHeaders: Headers
): Promise<OAuthInteractionSummary | undefined> {
  const issuer = getIssuerUrl()
  const webRequest = new Request(
    `${issuer}/oauth/authorize/interaction/${encodeURIComponent(uid)}/details`,
    { headers: requestHeaders }
  )
  const context = await createNodeHttpContext(
    webRequest,
    `/interaction/${encodeURIComponent(uid)}`
  )

  try {
    const provider = await getOidcProvider()
    const interaction = await provider.interactionDetails(
      context.request,
      context.response
    )
    if (interaction.uid !== uid) return undefined

    const params = interaction.params as Record<string, unknown>
    const clientId = stringParam(params, "client_id")
    const client = clientId
      ? await provider.Client.find(clientId)
      : undefined
    if (!client) return undefined

    return {
      uid,
      promptName: interaction.prompt.name,
      promptDetails: interaction.prompt.details,
      clientId,
      clientName: client.clientName ?? clientId,
      requestedScopes: stringParam(params, "scope")
        .split(" ")
        .filter(Boolean),
    }
  } finally {
    context.close()
  }
}
