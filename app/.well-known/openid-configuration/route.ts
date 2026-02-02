/**
 * OpenID Connect Discovery Endpoint
 * GET /.well-known/openid-configuration
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Returns the OIDC discovery document describing the provider's capabilities.
 */

import { NextResponse } from "next/server"
import { createLogger } from "@/lib/logger"

export async function GET(): Promise<NextResponse> {
  const log = createLogger({ action: "oidc.discovery" })

  try {
    const issuer =
      process.env.NEXTAUTH_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      "http://localhost:3000"

    const discovery = {
      issuer,
      authorization_endpoint: `${issuer}/api/oauth/auth`,
      token_endpoint: `${issuer}/api/oauth/token`,
      userinfo_endpoint: `${issuer}/api/oauth/userinfo`,
      jwks_uri: `${issuer}/api/oauth/jwks`,
      introspection_endpoint: `${issuer}/api/oauth/introspection`,
      revocation_endpoint: `${issuer}/api/oauth/revocation`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["openid", "profile", "email", "offline_access"],
      claims_supported: ["sub", "email", "name"],
    }

    return NextResponse.json(discovery, {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (error) {
    log.error("Discovery endpoint error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: "internal_server_error" },
      { status: 500 }
    )
  }
}
