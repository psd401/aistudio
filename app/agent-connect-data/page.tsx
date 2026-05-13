/**
 * Agent Connect — Cognito data-MCP consent page
 *
 * Public route (NOT under (protected), NOT in nav).
 * Accepts `?token=<signed-jwt>` issued by `/api/agent/consent-link` with
 * `kind: "cognito_data"`. The user clicks this link from Google Chat when
 * the agent needs to authenticate to the data MCP server on their behalf.
 *
 * Flow:
 *   1. Verify the consent JWT.
 *   2. Require an active AI Studio session whose email matches the JWT's `sub`.
 *      If not signed in, surface a sign-in link with this page as `callbackUrl`.
 *   3. Capture the session's Cognito refresh token and write it to Secrets
 *      Manager at `psd-agent-creds/{env}/user/{email}/cognito-refresh`.
 *   4. Burn the nonce (one-time use).
 *   5. Render confirmation. The user goes back to Chat and re-asks.
 *
 * This is a Server Component — no client-side JS required.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { createAuth } from "@/auth"
import { verifyConsentToken } from "@/lib/agent-workspace/consent-token"
import { executeQuery } from "@/lib/db/drizzle-client"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema/tables/agent-workspace-consent-nonces"
import { and, eq, isNull } from "drizzle-orm"
import { syncCognitoRefreshForAgent } from "@/lib/auth/agent-token-sync"
import { createLogger, sanitizeForLogging } from "@/lib/logger"

export const dynamic = "force-dynamic"

const log = createLogger({ module: "agent-connect-data" })

interface PageProps {
  searchParams: Promise<{ token?: string }>
}

type Outcome =
  | { status: "missing-token" }
  | { status: "invalid-token"; reason: string }
  | { status: "needs-signin"; ownerEmail: string; selfHref: string }
  | { status: "wrong-user"; expected: string; actual: string }
  | { status: "no-refresh-token"; ownerEmail: string }
  | { status: "already-consumed"; ownerEmail: string }
  | { status: "stored"; ownerEmail: string }
  | { status: "write-failed"; ownerEmail: string }

async function processConsent(token: string | undefined, selfPath: string): Promise<Outcome> {
  if (!token) return { status: "missing-token" }

  const payload = await verifyConsentToken(token)
  if (!payload) return { status: "invalid-token", reason: "Token is invalid or expired." }
  if (payload.kind !== "cognito_data") {
    return {
      status: "invalid-token",
      reason: "This link is for a different consent flow. Ask the agent for a fresh link.",
    }
  }

  const { auth } = createAuth()
  const session = await auth()
  if (!session?.user?.email) {
    return {
      status: "needs-signin",
      ownerEmail: payload.sub,
      selfHref: selfPath,
    }
  }

  const sessionEmail = session.user.email.toLowerCase()
  const targetEmail = payload.sub.toLowerCase()
  if (sessionEmail !== targetEmail) {
    return { status: "wrong-user", expected: payload.sub, actual: session.user.email }
  }

  // The session callback exposes the Cognito refresh token (auth.ts:323).
  const sessionWithToken = session as typeof session & { refreshToken?: string }
  const refreshToken = sessionWithToken.refreshToken
  if (!refreshToken || typeof refreshToken !== "string") {
    return { status: "no-refresh-token", ownerEmail: payload.sub }
  }

  // Atomic burn-then-write: try to mark the nonce consumed first. If the
  // update affects zero rows, the nonce was already consumed (replay) — we
  // treat that as success because the secret is already populated.
  const burn = await executeQuery(
    (db) =>
      db
        .update(psdAgentWorkspaceConsentNonces)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(psdAgentWorkspaceConsentNonces.nonce, payload.nonce),
            isNull(psdAgentWorkspaceConsentNonces.consumedAt),
          ),
        )
        .returning({ nonce: psdAgentWorkspaceConsentNonces.nonce }),
    "consumeCognitoDataConsentNonce",
  )

  if (burn.length === 0) {
    log.info(
      "Cognito-data consent nonce already consumed (replay or duplicate click)",
      sanitizeForLogging({ ownerEmail: payload.sub }),
    )
    return { status: "already-consumed", ownerEmail: payload.sub }
  }

  // Write the refresh token to Secrets Manager.
  const arn = await syncCognitoRefreshForAgent(payload.sub, refreshToken)
  if (!arn) {
    log.error(
      "Cognito-data consent: refresh-token sync returned null — IAM or env missing",
      sanitizeForLogging({ ownerEmail: payload.sub }),
    )
    return { status: "write-failed", ownerEmail: payload.sub }
  }

  log.info(
    "Cognito-data consent captured",
    sanitizeForLogging({ ownerEmail: payload.sub, secretArn: arn }),
  )
  return { status: "stored", ownerEmail: payload.sub }
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  )
}

export default async function AgentConnectDataPage({ searchParams }: PageProps) {
  const { token } = await searchParams
  const selfPath =
    `/agent-connect-data?token=${encodeURIComponent(token ?? "")}`
  const outcome = await processConsent(token, selfPath)

  if (outcome.status === "missing-token") {
    return (
      <Layout>
        <CardHeader>
          <CardTitle className="text-center text-red-600">No consent token</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground text-center">
          This page expects a one-time link from your agent. Ask the agent in
          Google Chat to send you a fresh consent link.
        </CardContent>
      </Layout>
    )
  }

  if (outcome.status === "invalid-token") {
    return (
      <Layout>
        <CardHeader>
          <CardTitle className="text-center text-red-600">Invalid consent link</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground text-center space-y-2">
          <p>{outcome.reason}</p>
          <p>Ask the agent for a fresh link.</p>
        </CardContent>
      </Layout>
    )
  }

  if (outcome.status === "needs-signin") {
    const signinHref = `/api/auth/signin?callbackUrl=${encodeURIComponent(outcome.selfHref)}`
    return (
      <Layout>
        <CardHeader>
          <CardTitle className="text-center">Sign in to connect your data access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            You&apos;re about to grant your agent permission to query the PSD
            data warehouse on your behalf, using your own row-level access.
            Sign in as <strong>{outcome.ownerEmail}</strong> to continue.
          </p>
          <div className="flex justify-center">
            <Button asChild>
              <Link href={signinHref}>Sign in to AI Studio</Link>
            </Button>
          </div>
        </CardContent>
      </Layout>
    )
  }

  if (outcome.status === "wrong-user") {
    return (
      <Layout>
        <CardHeader>
          <CardTitle className="text-center text-red-600">Wrong account</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground text-center space-y-2">
          <p>
            This link was issued for <strong>{outcome.expected}</strong>, but
            you&apos;re signed in as <strong>{outcome.actual}</strong>.
          </p>
          <p>Sign out and sign back in with the right account, then click the link again.</p>
        </CardContent>
      </Layout>
    )
  }

  if (outcome.status === "no-refresh-token") {
    return (
      <Layout>
        <CardHeader>
          <CardTitle className="text-center text-red-600">No refresh token on session</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground text-center space-y-2">
          <p>
            Your AI Studio session is missing the Cognito refresh token we need.
            Sign out, sign back in, and click the agent&apos;s consent link again.
          </p>
        </CardContent>
      </Layout>
    )
  }

  if (outcome.status === "write-failed") {
    return (
      <Layout>
        <CardHeader>
          <CardTitle className="text-center text-red-600">Could not save credential</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground text-center space-y-2">
          <p>
            We verified your identity but failed to store the credential. This
            usually means the deployment is missing IAM or environment
            configuration. Please ping the AI Studio team.
          </p>
        </CardContent>
      </Layout>
    )
  }

  // stored OR already-consumed → both render success
  return (
    <Layout>
      <CardHeader>
        <CardTitle className="text-center">You&apos;re connected</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          Your agent can now query PSD data warehouse on your behalf as{" "}
          <strong>{outcome.ownerEmail}</strong>. Row-level security still
          applies — the agent sees only what you can see.
        </p>
        <p>
          Head back to your Google Chat and re-ask your question.
        </p>
        <p className="text-xs">
          Revoke at any time by signing out of AI Studio; the stored token
          rotates on every login.
        </p>
      </CardContent>
    </Layout>
  )
}
