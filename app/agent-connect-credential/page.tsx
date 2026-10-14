/**
 * Agent Connect — one-time credential entry page (issue #1887).
 *
 * Public route (NOT under (protected), NOT in nav) but deliberately NOT in
 * middleware's PUBLIC_PATHS: a signed link proves integrity, not who opened
 * it, so a live AI Studio session is the second factor.
 *
 * Accepts `?token=<signed-jwt>` issued by `/api/agent/consent-link` with
 * `kind: "credential_entry"`. The user clicks this link from their chat with
 * the agent when a skill needs a secret the agent cannot read — an API key, a
 * vendor token — instead of being asked to paste the value into the chat.
 *
 * Flow:
 *   1. Verify the consent JWT (15-minute expiry, single-use nonce).
 *   2. Require a session whose email matches the JWT's `sub`.
 *   3. Render a single password-type input.
 *   4. On submit, the server action claims the nonce and writes the value
 *      through the credential broker's owner-scoped put path.
 *
 * The secret is only ever in the POST body of step 4. It never appears in the
 * URL, in a log line, or in the response.
 */

import { Button } from "@/components/ui/button"
import Link from "next/link"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger } from "@/lib/logger"
import {
  inspectCredentialEntry,
  type CredentialEntryInspection,
} from "@/lib/agent-workspace/credential-entry"
import { CredentialEntryForm } from "./_components/credential-entry-form"
import { EntryLayout, OutcomeCard } from "./_components/outcome-card"

export const dynamic = "force-dynamic"

const log = createLogger({ module: "agent-connect-credential-page" })

interface PageProps {
  searchParams: Promise<{ token?: string }>
}

/**
 * `inspectCredentialEntry` reads the database. An outage there must not drop
 * the user on the framework's generic error page — that reads as "your link is
 * broken", which sends them back to the agent for a replacement that will fail
 * the same way.
 */
type Outcome = CredentialEntryInspection | { status: "unavailable" }

async function inspect(
  token: string | undefined,
  sessionEmail: string | null
): Promise<Outcome> {
  try {
    return await inspectCredentialEntry(token, sessionEmail)
  } catch (error) {
    log.error("Credential-entry link could not be checked", {
      error: error instanceof Error ? error.message : String(error),
    })
    return { status: "unavailable" }
  }
}

export default async function AgentConnectCredentialPage({
  searchParams,
}: PageProps) {
  const { token } = await searchParams
  const session = await getServerSession()
  const outcome = await inspect(token, session?.email ?? null)

  if (outcome.status === "missing-token") {
    return (
      <EntryLayout>
        <OutcomeCard title="No credential link">
          <p className="text-center">
            This page expects a one-time link from your agent. Ask the agent to
            send you a fresh link.
          </p>
        </OutcomeCard>
      </EntryLayout>
    )
  }

  if (outcome.status === "invalid-token") {
    return (
      <EntryLayout>
        <OutcomeCard
          title="Invalid or expired link"
          testId="credential-entry-invalid"
        >
          <p className="text-center">
            This credential link is not valid, or it expired — these links last
            15 minutes.
          </p>
          <p className="text-center">Ask your agent for a fresh link.</p>
        </OutcomeCard>
      </EntryLayout>
    )
  }

  if (outcome.status === "unavailable") {
    return (
      <EntryLayout>
        <OutcomeCard
          title="Something went wrong on our side"
          testId="credential-entry-unavailable"
        >
          <p className="text-center">
            We could not check your link just now. Your link has not been used —
            wait a moment and reload this page.
          </p>
          <p className="text-center">
            If it keeps happening, tell the AI Studio team.
          </p>
        </OutcomeCard>
      </EntryLayout>
    )
  }

  if (outcome.status === "needs-signin") {
    const selfHref = `/agent-connect-credential?token=${encodeURIComponent(token ?? "")}`
    const signinHref = `/api/auth/signin?callbackUrl=${encodeURIComponent(selfHref)}`
    return (
      <EntryLayout>
        <OutcomeCard title="Sign in to store your credential" tone="neutral">
          <p>
            This link stores a secret for your agent. Sign in as{" "}
            <strong>{outcome.ownerEmail}</strong> to continue.
          </p>
          <div className="flex justify-center pt-1">
            <Button asChild>
              <Link href={signinHref}>Sign in to AI Studio</Link>
            </Button>
          </div>
        </OutcomeCard>
      </EntryLayout>
    )
  }

  if (outcome.status === "wrong-user") {
    return (
      <EntryLayout>
        <OutcomeCard
          title="This link isn't yours"
          testId="credential-entry-wrong-user"
        >
          {/*
            Deliberately does NOT name the owner. Whoever opened this was not
            the intended recipient, and the link may have been forwarded or
            leaked — there is no reason to hand them an address too.
          */}
          <p className="text-center">
            This credential link was issued for a different account and cannot
            be used by anyone else.
          </p>
          <p className="text-center">
            If it was meant for you, sign out, sign back in with the right
            account, and open the link again.
          </p>
        </OutcomeCard>
      </EntryLayout>
    )
  }

  if (outcome.status === "already-used") {
    return (
      <EntryLayout>
        <OutcomeCard title="Link already used" testId="credential-entry-used">
          <p className="text-center">
            This one-time link has already been used. Ask your agent for a fresh
            link if you need to store or replace the value.
          </p>
        </OutcomeCard>
      </EntryLayout>
    )
  }

  return (
    <EntryLayout>
      <CredentialEntryForm
        token={token ?? ""}
        credentialName={outcome.credentialName}
        ownerEmail={outcome.ownerEmail}
      />
    </EntryLayout>
  )
}
