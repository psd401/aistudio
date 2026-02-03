/**
 * OAuth Consent Form
 * Client component for approve/deny buttons.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { approveConsent, denyConsent } from "@/actions/oauth/consent.actions"

interface ConsentFormProps {
  uid: string
  scopes: string[]
}

export function ConsentForm({ uid, scopes }: ConsentFormProps) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleApprove() {
    setIsLoading(true)
    setError(null)
    try {
      const result = await approveConsent(uid, scopes)
      if (result.isSuccess && result.data?.redirectTo) {
        router.push(result.data.redirectTo)
      } else {
        setError(result.message || "Failed to authorize")
      }
    } catch {
      setError("An unexpected error occurred")
    } finally {
      setIsLoading(false)
    }
  }

  async function handleDeny() {
    setIsLoading(true)
    setError(null)
    try {
      const result = await denyConsent(uid)
      if (result.isSuccess && result.data?.redirectTo) {
        router.push(result.data.redirectTo)
      } else {
        setError(result.message || "Failed to deny authorization")
      }
    } catch {
      setError("An unexpected error occurred")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="mt-8 space-y-3">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}
      <div className="flex gap-3">
        <Button
          variant="outline"
          className="flex-1"
          onClick={handleDeny}
          disabled={isLoading}
        >
          Deny
        </Button>
        <Button
          className="flex-1"
          onClick={handleApprove}
          disabled={isLoading}
        >
          {isLoading ? "Authorizing..." : "Authorize"}
        </Button>
      </div>
    </div>
  )
}
