"use client"

import { useSearchParams } from "next/navigation"
import { useEffect, useState, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { handleOAuthCallback, type OAuthCallbackResult } from "@/actions/agent-workspace.actions"

export function OAuthCallbackClient() {
  const searchParams = useSearchParams()
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const errorParam = searchParams.get("error")

  const [result, setResult] = useState<OAuthCallbackResult | null>(null)
  const [loading, setLoading] = useState(true)
  const processedRef = useRef<string | null>(null)

  useEffect(() => {
    // Handle Google OAuth error responses
    if (errorParam) {
      setResult({
        success: false,
        error: `Google denied the authorization request: ${errorParam}`,
      })
      setLoading(false)
      return
    }

    if (!code || !state) {
      setResult({
        success: false,
        error: "Missing authorization code or state parameter.",
      })
      setLoading(false)
      return
    }

    // Prevent double-processing (parameterized route guard)
    const key = `${code}:${state}`
    if (processedRef.current === key) {
      return
    }
    processedRef.current = key

    async function processCallback() {
      setLoading(true)
      const response = await handleOAuthCallback(code!, state!)
      if (response.isSuccess && response.data) {
        setResult(response.data)
      } else {
        setResult({ success: false, error: response.message })
      }
      setLoading(false)
    }

    processCallback()
  }, [code, state, errorParam])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-muted-foreground">
              Completing authorization with Google...
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!result?.success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-center text-red-600">
              Authorization Failed
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center">
            <p className="text-muted-foreground mb-4">
              {result?.error ?? "An unknown error occurred."}
            </p>
            <p className="text-sm text-muted-foreground">
              Return to Google Chat and ask your agent for a new link.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-green-700">
            Your Agent is Connected
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground text-center">
            <strong>{result.agentEmail}</strong> now has Google Workspace access
            for <strong>{result.ownerEmail}</strong>.
          </p>

          <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
            <p className="text-sm text-amber-800 font-medium mb-2">
              Next Steps: Delegate Your Gmail and Calendar
            </p>
            <p className="text-sm text-amber-700 mb-2">
              For your agent to read your inbox and manage your calendar, you
              need to explicitly delegate access:
            </p>
            <ul className="text-sm text-amber-700 list-disc list-inside space-y-1">
              <li>
                <strong>Gmail:</strong>{" "}
                <a
                  href="https://support.google.com/mail/answer/138350"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Add a delegate in Gmail Settings
                </a>
              </li>
              <li>
                <strong>Calendar:</strong>{" "}
                <a
                  href="https://support.google.com/calendar/answer/37082"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Share your calendar with your agent
                </a>
              </li>
            </ul>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            You can now close this tab and return to Google Chat. Your agent will
            be able to use Google Workspace on your next request.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
