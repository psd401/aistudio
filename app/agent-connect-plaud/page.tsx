/**
 * Agent Connect (Plaud) — Plaud OAuth consent start page.
 *
 * Public page (NOT under (protected), NOT in nav). Accepts ?token=<signed-jwt>.
 * Verifies the consent token, then renders a "Connect your Plaud account"
 * button that redirects to Plaud's OAuth consent screen (PKCE).
 */

import { Suspense } from "react"
import { PlaudConnectClient } from "./_components/plaud-connect-client"

export const dynamic = "force-dynamic"

export default function AgentConnectPlaudPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-lg text-muted-foreground">Verifying...</div>
        </div>
      }
    >
      <PlaudConnectClient />
    </Suspense>
  )
}
