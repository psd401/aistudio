/**
 * Explicit first-party OAuth grant policy.
 *
 * Trust comes only from the persisted `is_first_party` client metadata flag.
 * Names, application type, redirect shape, and requested scopes never imply
 * first-party status.
 */

import type {
  Client,
  Configuration,
  Grant,
  KoaContextWithOIDC,
} from "oidc-provider"
import { interactionPolicy } from "oidc-provider"
import { OIDC_SCOPES } from "./oauth-scopes"

const OIDC_SCOPE_SET = new Set(OIDC_SCOPES)

interface FirstPartyScopePartition {
  oidcScopes: string[]
  contentScopes: string[]
}

function splitScopes(value: unknown): string[] {
  if (typeof value !== "string") return []
  return value.split(" ").filter(Boolean)
}

export function isExplicitFirstPartyClient(
  client: Client | undefined
): boolean {
  return client?.metadata().is_first_party === true
}

/**
 * Intersect the request with the client's registered scope allowlist, then
 * partition the scopes into the grant sections oidc-provider consumes.
 */
export function partitionRegisteredFirstPartyScopes(
  requestedScope: unknown,
  registeredScope: unknown
): FirstPartyScopePartition {
  const registered = new Set(splitScopes(registeredScope))
  const requested = splitScopes(requestedScope).filter((scope) =>
    registered.has(scope)
  )

  return {
    oidcScopes: requested.filter((scope) => OIDC_SCOPE_SET.has(scope)),
    contentScopes: requested.filter((scope) => scope.startsWith("content:")),
  }
}

async function findExistingGrant(
  ctx: KoaContextWithOIDC
): Promise<Grant | undefined> {
  const client = ctx.oidc.client
  if (!client) return undefined

  const resultGrantId = ctx.oidc.result?.consent?.grantId
  const sessionGrantId = ctx.oidc.session?.grantIdFor(client.clientId)
  const grantId = resultGrantId ?? sessionGrantId
  return grantId
    ? ctx.oidc.provider.Grant.find(grantId)
    : undefined
}

export function createFirstPartyLoadExistingGrant(
  resourceServer: string
): NonNullable<Configuration["loadExistingGrant"]> {
  return async (ctx) => {
    const client = ctx.oidc.client
    const existingGrant = await findExistingGrant(ctx)

    if (!client || !isExplicitFirstPartyClient(client)) {
      return existingGrant
    }

    const accountId = ctx.oidc.account?.accountId
    if (!accountId) {
      // Preserve the login prompt. A first-party designation is not an identity.
      return existingGrant
    }

    if (
      existingGrant &&
      (existingGrant.accountId !== accountId ||
        existingGrant.clientId !== client.clientId)
    ) {
      throw new Error("Existing OAuth grant principal mismatch")
    }

    const grant =
      existingGrant ??
      new ctx.oidc.provider.Grant({
        accountId,
        clientId: client.clientId,
      })
    const scopes = partitionRegisteredFirstPartyScopes(
      ctx.oidc.params?.scope,
      client.scope
    )

    if (scopes.oidcScopes.length > 0) {
      grant.addOIDCScope(scopes.oidcScopes.join(" "))
    }
    if (scopes.contentScopes.length > 0) {
      grant.addResourceScope(
        resourceServer,
        scopes.contentScopes.join(" ")
      )
    }

    await grant.save()
    return grant
  }
}

/**
 * Keep the provider's default login and consent policy. The sole exception is
 * the default "native clients always re-consent" check for an explicitly
 * trusted client; loadExistingGrant still has to satisfy every requested scope.
 */
export function createOAuthInteractionPolicy(): interactionPolicy.DefaultPolicy {
  const policy = interactionPolicy.base()
  const consentPrompt = policy.get("consent")
  const oidcScopeCheckIndex =
    consentPrompt?.checks.findIndex(
      (check) => check.reason === "op_scopes_missing"
    ) ?? -1
  const nativeCheckIndex =
    consentPrompt?.checks.findIndex(
      (check) => check.reason === "native_client_prompt"
    ) ?? -1

  if (
    !consentPrompt ||
    nativeCheckIndex < 0 ||
    oidcScopeCheckIndex < 0
  ) {
    throw new Error("oidc-provider consent policy has an unexpected shape")
  }

  // `scopes` must continue to advertise and validate API scopes against each
  // client's allowlist. oidc-provider consequently includes those configured
  // values in requestParamOIDCScopes even though they belong to the resource
  // server. Narrow only this consent check to actual OIDC scopes; the default
  // rs_scopes_missing check still handles content/API scopes.
  const missingOidcScopes = new WeakMap<
    KoaContextWithOIDC,
    string[]
  >()
  consentPrompt.checks.remove("op_scopes_missing")
  consentPrompt.checks.add(
    new interactionPolicy.Check(
      "op_scopes_missing",
      "requested OIDC scopes not granted",
      (ctx) => {
        const oidc = ctx.oidc as typeof ctx.oidc & {
          grant: Grant
          requestParamOIDCScopes: Set<string>
        }
        const encountered = new Set(
          oidc.grant.getOIDCScopeEncountered().split(" ")
        )
        const missing = [...oidc.requestParamOIDCScopes].filter(
          (scope) =>
            OIDC_SCOPE_SET.has(scope) && !encountered.has(scope)
        )
        if (missing.length === 0) {
          missingOidcScopes.delete(ctx)
          return interactionPolicy.Check.NO_NEED_TO_PROMPT
        }
        missingOidcScopes.set(ctx, missing)
        return interactionPolicy.Check.REQUEST_PROMPT
      },
      (ctx) => {
        const missing = missingOidcScopes.get(ctx)
        return missing ? { missingOIDCScope: missing } : {}
      }
    ),
    oidcScopeCheckIndex
  )

  consentPrompt.checks.remove("native_client_prompt")
  consentPrompt.checks.add(
    new interactionPolicy.Check(
      "native_client_prompt",
      "untrusted native clients require End-User interaction",
      "interaction_required",
      (ctx) =>
        !isExplicitFirstPartyClient(ctx.oidc.client) &&
        ctx.oidc.client?.applicationType === "native" &&
        ctx.oidc.params?.response_type !== "none" &&
        !ctx.oidc.result?.consent
    ),
    nativeCheckIndex
  )

  return policy
}
