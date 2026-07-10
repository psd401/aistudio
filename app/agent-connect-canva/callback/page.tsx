/**
 * Canva OAuth callback — Canva redirects here with ?code & ?state after the
 * user consents. Exchanges the code (+ stored PKCE verifier) for a refresh
 * token and stores it per-user. Public page (redirect_uri target).
 */

import { Suspense } from "react"
import { CanvaCallbackClient } from "./_components/canva-callback-client"

export const dynamic = "force-dynamic"

export default function CanvaCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-lg text-muted-foreground">Connecting your Canva account...</div>
        </div>
      }
    >
      <CanvaCallbackClient />
    </Suspense>
  )
}
