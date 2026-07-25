/**
 * Mount oidc-provider's internally generated authorization resume URL.
 *
 * The public provider endpoints enter through `/api/oauth/*`, but the issuer
 * remains the site origin so oidc-provider correctly returns `/auth/:uid`.
 * This route forwards that exact provider URL without constructing or
 * rewriting an interaction destination.
 */

import type { NextRequest } from "next/server"
import { getOidcProvider } from "@/lib/oauth/oidc-provider-config"
import { invokeNodeHttpHandler } from "@/lib/oauth/node-http-adapter"
import { isOidcProviderResumePath } from "@/lib/oauth/resume-path"
import { createLogger, generateRequestId } from "@/lib/logger"

export const runtime = "nodejs"

export async function GET(request: NextRequest): Promise<Response> {
  const log = createLogger({
    requestId: generateRequestId(),
    action: "oauth.authorization.resume",
  })

  try {
    const url = new URL(request.url)
    if (!isOidcProviderResumePath(url.pathname)) {
      return Response.json({ error: "not_found" }, { status: 404 })
    }

    const provider = await getOidcProvider()
    return await invokeNodeHttpHandler(
      request,
      url.pathname + url.search,
      provider.callback()
    )
  } catch (error) {
    log.warn("OAuth authorization could not be resumed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json(
      { error: "invalid_or_expired_interaction" },
      { status: 400 }
    )
  }
}
