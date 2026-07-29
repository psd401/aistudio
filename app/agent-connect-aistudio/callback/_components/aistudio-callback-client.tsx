"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import {
  handleAistudioCallback,
  type AistudioCallbackResult,
} from "@/actions/agent-aistudio.actions"

export function AistudioCallbackClient() {
  const searchParams = useSearchParams()
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const oauthError = searchParams.get("error")
  const parameterError = oauthError
    ? `AI Studio reported: ${oauthError}. Ask your agent for a new link.`
    : !code || !state
      ? "Missing authorization response. Ask your agent for a new link."
      : null
  const [result, setResult] = useState<AistudioCallbackResult | null>(null)

  useEffect(() => {
    if (parameterError || !code || !state) return
    let cancelled = false
    void (async () => {
      const response = await handleAistudioCallback(code, state)
      if (cancelled) return
      setResult(
        response.isSuccess
          ? response.data
          : { success: false, error: response.message }
      )
    })()
    return () => {
      cancelled = true
    }
  }, [code, state, parameterError])

  const error =
    parameterError ?? (result && !result.success ? result.error : null)
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
        {!error && result === null && (
          <p className="text-muted-foreground">Connecting AI Studio...</p>
        )}
        {result?.success && (
          <>
            <h1 className="mb-2 text-xl font-semibold">AI Studio connected</h1>
            <p className="text-muted-foreground">
              OpenClaw can now use your authorized repository catalog. You can
              close this tab and return to chat.
            </p>
          </>
        )}
        {error && (
          <>
            <h1 className="mb-2 text-xl font-semibold">
              Couldn&apos;t connect
            </h1>
            <p className="text-destructive">{error}</p>
          </>
        )}
      </div>
    </div>
  )
}
