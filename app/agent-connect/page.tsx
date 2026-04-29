/**
 * Agent Connect — Google Workspace OAuth consent start page
 *
 * Public page (NOT under (protected), NOT in nav).
 * Accepts ?token=<signed-jwt> query param.
 * Verifies the token, then renders a "Click to authorize" button that
 * redirects to Google's OAuth consent screen.
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration
 */

import { Suspense } from "react"
import { AgentConnectClient } from "./_components/agent-connect-client"

export const dynamic = "force-dynamic"

export default function AgentConnectPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-lg text-muted-foreground">Verifying...</div>
        </div>
      }
    >
      <AgentConnectClient />
    </Suspense>
  )
}
