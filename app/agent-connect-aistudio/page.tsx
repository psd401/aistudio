import { Suspense } from "react"
import { AistudioConnectClient } from "./_components/aistudio-connect-client"

export const dynamic = "force-dynamic"

export default function AgentConnectAistudioPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-lg text-muted-foreground">Verifying...</div>
        </div>
      }
    >
      <AistudioConnectClient />
    </Suspense>
  )
}
