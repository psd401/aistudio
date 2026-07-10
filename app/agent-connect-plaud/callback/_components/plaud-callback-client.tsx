"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { handlePlaudCallback, type PlaudCallbackResult } from "@/actions/agent-plaud.actions"

export function PlaudCallbackClient() {
  const searchParams = useSearchParams()
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const oauthError = searchParams.get("error")

  // Derived (no sync setState in the effect): parameter-level errors render immediately.
  const paramError = oauthError
    ? `Plaud reported: ${oauthError}. Please try the link again.`
    : !code || !state
      ? "Missing authorization code. Ask your agent for a new link."
      : null

  const [result, setResult] = useState<PlaudCallbackResult | null>(null)

  useEffect(() => {
    if (paramError || !code || !state) return
    let cancelled = false
    void (async () => {
      const response = await handlePlaudCallback(code, state)
      if (cancelled) return
      if (response.isSuccess && response.data) setResult(response.data)
      else setResult({ success: false, error: response.isSuccess ? "Connection failed." : response.message })
    })()
    return () => { cancelled = true }
  }, [code, state, paramError])

  const errorMsg = paramError ?? (result && !result.success ? result.error : null)
  const success = !paramError && result?.success === true
  const pending = !paramError && result === null

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 shadow-sm text-center">
        {pending && <p className="text-muted-foreground">Connecting your Plaud account...</p>}
        {success && (
          <>
            <h1 className="mb-2 text-xl font-semibold">Plaud connected ✅</h1>
            <p className="text-muted-foreground">
              Your agent can now read your Plaud recordings. You can close this tab and
              return to chat.
            </p>
          </>
        )}
        {errorMsg && (
          <>
            <h1 className="mb-2 text-xl font-semibold">Couldn&apos;t connect</h1>
            <p className="text-destructive">{errorMsg}</p>
          </>
        )}
      </div>
    </div>
  )
}
