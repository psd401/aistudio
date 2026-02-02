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

  async function handleApprove() {
    setIsLoading(true)
    try {
      const result = await approveConsent(uid, scopes)
      if (result.isSuccess && result.data?.redirectTo) {
        router.push(result.data.redirectTo)
      }
    } finally {
      setIsLoading(false)
    }
  }

  async function handleDeny() {
    setIsLoading(true)
    try {
      const result = await denyConsent(uid)
      if (result.isSuccess && result.data?.redirectTo) {
        router.push(result.data.redirectTo)
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="mt-8 flex gap-3">
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
  )
}
