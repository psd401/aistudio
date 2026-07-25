/**
 * Complete custom oidc-provider login and consent interactions.
 *
 * All interaction state is read and completed through oidc-provider's public
 * interactionDetails/interactionFinished APIs. The browser-provided uid is
 * only an expected identifier; the signed interaction cookie is authoritative.
 */

import { NextRequest } from "next/server"
import type { Grant, Interaction, Provider } from "oidc-provider"
import { getOidcProvider } from "@/lib/oauth/oidc-provider-config"
import { invokeNodeHttpHandler } from "@/lib/oauth/node-http-adapter"
import { getServerSession } from "@/lib/auth/server-session"
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle/utils"
import { consumeConsentDecision } from "@/lib/oauth/consent-decisions"
import { createLogger, generateRequestId } from "@/lib/logger"

export const runtime = "nodejs"

type OidcProvider = InstanceType<typeof Provider>

interface RouteContext {
  params: Promise<{
    uid: string
    action: string
  }>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string")
    ? value
    : []
}

function registeredScopes(providerClientScope: string | undefined): Set<string> {
  return new Set((providerClientScope ?? "").split(" ").filter(Boolean))
}

function assertRegisteredScopes(
  scopes: string[],
  registered: Set<string>
): void {
  if (scopes.some((scope) => !registered.has(scope))) {
    throw new Error("OAuth consent contained an unregistered scope")
  }
}

function requiredInteractionAccount(
  interaction: Interaction,
  decisionUserId: number
): string {
  const accountId = interaction.session?.accountId
  if (!accountId || accountId !== String(decisionUserId)) {
    throw new Error("OAuth consent principal mismatch")
  }
  return accountId
}

async function consentGrant(
  provider: OidcProvider,
  interaction: Interaction,
  accountId: string
): Promise<Grant> {
  const clientId = asString(interaction.params.client_id)
  if (!clientId) throw new Error("OAuth interaction is missing client_id")

  const client = await provider.Client.find(clientId)
  if (!client) throw new Error("OAuth client is inactive or unavailable")

  const registered = registeredScopes(client.scope)
  let grant = interaction.grantId
    ? await provider.Grant.find(interaction.grantId)
    : undefined
  if (
    grant &&
    (grant.accountId !== accountId || grant.clientId !== clientId)
  ) {
    throw new Error("OAuth grant principal mismatch")
  }
  grant ??= new provider.Grant({ accountId, clientId })

  const details = interaction.prompt.details
  const oidcScopes = asStringArray(details.missingOIDCScope)
  assertRegisteredScopes(oidcScopes, registered)
  if (oidcScopes.length > 0) {
    grant.addOIDCScope(oidcScopes.join(" "))
  }

  const oidcClaims = asStringArray(details.missingOIDCClaims)
  if (oidcClaims.length > 0) {
    grant.addOIDCClaims(oidcClaims)
  }

  const missingResources = details.missingResourceScopes
  if (
    missingResources &&
    typeof missingResources === "object" &&
    !Array.isArray(missingResources)
  ) {
    for (const [resource, value] of Object.entries(missingResources)) {
      const scopes = asStringArray(value)
      assertRegisteredScopes(scopes, registered)
      if (scopes.length > 0) {
        grant.addResourceScope(resource, scopes.join(" "))
      }
    }
  }

  await grant.save()
  return grant
}

async function finishLogin(
  provider: OidcProvider,
  interaction: Interaction,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse
): Promise<void> {
  if (interaction.prompt.name !== "login") {
    throw new Error("OAuth interaction is not awaiting login")
  }

  const session = await getServerSession()
  const userId = session?.sub
    ? await getUserIdByCognitoSubAsNumber(session.sub)
    : null
  if (!userId) {
    const callbackUrl = `/oauth/authorize?uid=${encodeURIComponent(
      interaction.uid
    )}`
    response.statusCode = 303
    response.setHeader(
      "Location",
      `/api/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`
    )
    response.end()
    return
  }

  await provider.interactionFinished(
    request,
    response,
    {
      login: {
        accountId: String(userId),
      },
    },
    { mergeWithLastSubmission: false }
  )
}

async function finishConsentDecision(
  provider: OidcProvider,
  interaction: Interaction,
  action: "consent" | "abort",
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse
): Promise<void> {
  if (interaction.prompt.name !== "consent") {
    throw new Error("OAuth interaction is not awaiting consent")
  }

  const decision = await consumeConsentDecision(interaction.uid)
  if (!decision || decision.approved !== (action === "consent")) {
    throw new Error("OAuth consent decision is missing or inconsistent")
  }

  const session = await getServerSession()
  const currentUserId = session?.sub
    ? await getUserIdByCognitoSubAsNumber(session.sub)
    : null
  if (!currentUserId || currentUserId !== decision.userId) {
    throw new Error("OAuth consent session principal mismatch")
  }

  const accountId = requiredInteractionAccount(
    interaction,
    decision.userId
  )
  if (!decision.approved) {
    await provider.interactionFinished(
      request,
      response,
      {
        error: "access_denied",
        error_description: "End-User denied authorization",
      },
      { mergeWithLastSubmission: false }
    )
    return
  }

  const grant = await consentGrant(provider, interaction, accountId)
  await provider.interactionFinished(
    request,
    response,
    { consent: { grantId: grant.jti } },
    { mergeWithLastSubmission: true }
  )
}

export async function GET(
  request: NextRequest,
  context: RouteContext
): Promise<Response> {
  const requestId = generateRequestId()
  const log = createLogger({
    requestId,
    action: "oauth.interaction.complete",
  })

  try {
    const { uid, action } = await context.params
    if (
      action !== "login" &&
      action !== "consent" &&
      action !== "abort"
    ) {
      return Response.json(
        { error: "invalid_interaction_action" },
        { status: 404 }
      )
    }

    const provider = await getOidcProvider()
    const url = new URL(request.url)
    return await invokeNodeHttpHandler(
      request,
      url.pathname + url.search,
      async (nodeRequest, nodeResponse) => {
        const interaction = await provider.interactionDetails(
          nodeRequest,
          nodeResponse
        )
        if (interaction.uid !== uid) {
          throw new Error("OAuth interaction identifier mismatch")
        }

        if (action === "login") {
          await finishLogin(
            provider,
            interaction,
            nodeRequest,
            nodeResponse
          )
          return
        }
        await finishConsentDecision(
          provider,
          interaction,
          action,
          nodeRequest,
          nodeResponse
        )
      }
    )
  } catch (error) {
    log.warn("OAuth interaction could not be completed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json(
      { error: "invalid_or_expired_interaction" },
      { status: 400 }
    )
  }
}
