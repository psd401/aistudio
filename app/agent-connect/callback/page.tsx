/**
 * Agent Connect Callback — Google OAuth callback handler
 *
 * Public page (NOT under (protected), NOT in nav).
 * Receives ?code=<auth-code>&state=<signed-token> from Google OAuth.
 * Exchanges the code for a refresh token and stores it.
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration
 */

import { Suspense } from "react"
import { OAuthCallbackClient } from "./_components/oauth-callback-client"

export const dynamic = "force-dynamic"

export default function AgentConnectCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-lg text-muted-foreground">
            Completing authorization...
          </div>
        </div>
      }
    >
      <OAuthCallbackClient />
    </Suspense>
  )
}
