"use client"

import { useSearchParams } from "next/navigation"
import { useEffect, useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { verifyConsentAndGetOAuthUrl, type VerifyConsentResult } from "@/actions/agent-workspace.actions"

export function AgentConnectClient() {
  const searchParams = useSearchParams()
  const token = searchParams.get("token")
  const [result, setResult] = useState<VerifyConsentResult | null>(null)
  const [loading, setLoading] = useState(true)
  const verifiedTokenRef = useRef<string | null>(null)

  useEffect(() => {
    async function verify() {
      if (!token) {
        setResult({ valid: false, error: "No consent token provided." })
        setLoading(false)
        return
      }

      // Prevent double-verification on the same token (parameterized route guard).
      // Not a security comparison — just a UI dedup guard.
      // eslint-disable-next-line security/detect-possible-timing-attacks
      if (verifiedTokenRef.current === token) {
        return
      }
      verifiedTokenRef.current = token

      setLoading(true)
      const response = await verifyConsentAndGetOAuthUrl(token)
      if (response.isSuccess && response.data) {
        setResult(response.data)
      } else {
        setResult({ valid: false, error: response.message })
      }
      setLoading(false)
    }

    verify()
  }, [token])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-muted-foreground">Verifying consent link...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!result?.valid) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-center text-red-600">
              Invalid Consent Link
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center">
            <p className="text-muted-foreground mb-4">
              {result?.error ?? "This link is invalid or has expired."}
            </p>
            <p className="text-sm text-muted-foreground">
              Ask your agent for a new link in Google Chat.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // The consent UI shows different copy depending on which slot the user is
  // connecting (#912 Phase 1). Default to agent_account semantics for legacy
  // tokens that predate the kind field.
  const kind = result.kind ?? "agent_account"
  const isUserAccount = kind === "user_account"

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center">
            {isUserAccount
              ? "Let Your Agent See Your Inbox and To-Dos"
              : "Connect Your Agent to Google Workspace"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground space-y-2">
            {isUserAccount ? (
              <>
                <p>
                  You are granting <strong>your agent</strong> permission to
                  read your <strong>own</strong> Gmail and Tasks
                  (<strong>{result.ownerEmail}</strong>) and to create drafts,
                  events, tasks, and Drive files on your behalf.
                </p>
                <p>
                  Phase 1 limits: <strong>read-only mail (no sending), drafts
                  only, no deletes.</strong> The agent always marks artifacts
                  it creates so you can audit them. You can revoke access any
                  time at <code>myaccount.google.com/permissions</code>.
                </p>
              </>
            ) : (
              <>
                <p>
                  You are authorizing <strong>{result.agentEmail}</strong> to
                  access Google Workspace on your behalf.
                </p>
                <p>
                  This will grant your agent access to Gmail, Calendar, Drive,
                  Docs, Meet, and Chat through the agent account.
                </p>
              </>
            )}
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
            {isUserAccount ? (
              <p className="text-sm text-blue-800">
                <strong>Important:</strong> You will be asked to sign in as
                yourself (<strong>{result.ownerEmail}</strong>) — your normal
                Google account.
              </p>
            ) : (
              <p className="text-sm text-blue-800">
                <strong>Important:</strong> You will be asked to sign in as
                the agent account (<strong>{result.agentEmail}</strong>),
                not your personal account. Use the temporary password
                provided by IT.
              </p>
            )}
          </div>
          <Button
            className="w-full"
            size="lg"
            onClick={() => {
              if (result.googleOAuthUrl) {
                window.location.href = result.googleOAuthUrl
              }
            }}
          >
            {isUserAccount
              ? "Grant Inbox and To-Do Access"
              : "Authorize Google Workspace Access"}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
