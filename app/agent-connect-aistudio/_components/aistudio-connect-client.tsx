"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { verifyAistudioConsentAndGetOAuthUrl } from "@/actions/agent-aistudio.actions"

export function AistudioConnectClient() {
  const searchParams = useSearchParams()
  const token = searchParams.get("token")
  const [oauthUrl, setOauthUrl] = useState<string | null>(null)
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null)
  const [asyncError, setAsyncError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      const result = await verifyAistudioConsentAndGetOAuthUrl(token)
      if (cancelled) return
      if (result.isSuccess && result.data.valid && result.data.oauthUrl) {
        setOauthUrl(result.data.oauthUrl)
        setOwnerEmail(result.data.ownerEmail ?? null)
      } else {
        setAsyncError(
          (result.isSuccess && result.data.error) ||
            (!result.isSuccess ? result.message : "") ||
            "This connection link is invalid or expired."
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  const error = token
    ? asyncError
    : "Missing connection token. Ask your agent for a new link."

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">Connect AI Studio</h1>
        {error ? (
          <p className="text-destructive">{error}</p>
        ) : oauthUrl ? (
          <>
            <p className="mb-6 text-muted-foreground">
              Authorize OpenClaw to discover and search the AI Studio repositories
              you can access{ownerEmail ? ` as ${ownerEmail}` : ""}. Access follows
              your current repository permissions and can be revoked.
            </p>
            <a
              href={oauthUrl}
              className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90"
            >
              Continue to AI Studio
            </a>
          </>
        ) : (
          <p className="text-muted-foreground">Verifying your link...</p>
        )}
      </div>
    </div>
  )
}
