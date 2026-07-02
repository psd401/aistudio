"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { verifyPlaudConsentAndGetOAuthUrl } from "@/actions/agent-plaud.actions"

type Ready = { ownerEmail?: string; oauthUrl: string }

export function PlaudConnectClient() {
  const searchParams = useSearchParams()
  const token = searchParams.get("token")
  const [ready, setReady] = useState<Ready | null>(null)
  const [asyncError, setAsyncError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return // missing-token is derived below; no sync setState here
    let cancelled = false
    void (async () => {
      const res = await verifyPlaudConsentAndGetOAuthUrl(token)
      if (cancelled) return
      if (res.isSuccess && res.data.valid && res.data.plaudOAuthUrl) {
        setReady({ ownerEmail: res.data.ownerEmail, oauthUrl: res.data.plaudOAuthUrl })
      } else {
        setAsyncError(
          (res.isSuccess && res.data.error) ||
            (!res.isSuccess ? res.message : "") ||
            "This consent link is invalid or has expired. Ask your agent for a new one."
        )
      }
    })()
    return () => { cancelled = true }
  }, [token])

  const error = !token ? "Missing consent token. Ask your agent for a new link." : asyncError

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">Connect your Plaud account</h1>
        {error ? (
          <p className="text-destructive">{error}</p>
        ) : ready ? (
          <>
            <p className="mb-6 text-muted-foreground">
              This lets your PSD agent read <strong>your own</strong> Plaud recordings
              (transcripts and summaries){ready.ownerEmail ? ` for ${ready.ownerEmail}` : ""}. You
              can disconnect at any time. The agent summarizes recordings and does not
              retain raw transcripts.
            </p>
            <a
              href={ready.oauthUrl}
              className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90"
            >
              Connect Plaud
            </a>
          </>
        ) : (
          <p className="text-muted-foreground">Verifying your link...</p>
        )}
      </div>
    </div>
  )
}
