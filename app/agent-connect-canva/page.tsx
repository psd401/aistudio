/**
 * Agent Connect (Canva) — Canva OAuth consent start page.
 *
 * Public page (NOT under (protected), NOT in nav). Accepts ?token=<signed-jwt>.
 * Verifies the consent token, then renders a "Connect your Canva account"
 * button that redirects to Canva's OAuth consent screen (PKCE).
 */

import { Suspense } from "react"
import { CanvaConnectClient } from "./_components/canva-connect-client"

export const dynamic = "force-dynamic"

export default function AgentConnectCanvaPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-lg text-muted-foreground">Verifying...</div>
        </div>
      }
    >
      <CanvaConnectClient />
    </Suspense>
  )
}
