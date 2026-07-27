import { Suspense } from "react"
import { AistudioCallbackClient } from "./_components/aistudio-callback-client"

export const dynamic = "force-dynamic"

export default function AistudioCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-lg text-muted-foreground">Connecting...</div>
        </div>
      }
    >
      <AistudioCallbackClient />
    </Suspense>
  )
}
