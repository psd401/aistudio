"use client"

/**
 * One-time credential entry form (issue #1887).
 *
 * A single password-type input. The value is held in component state and sent
 * only as a server-action argument, so it is never placed in a URL, never put
 * in `localStorage`, and never echoed back by the server.
 *
 * `autoComplete="off"` is deliberate: this field is not the user's password
 * for this site, and offering to save a vendor API key in the browser's
 * password manager would be the wrong affordance. (Chromium ignores it on
 * `type="password"` and may still offer; nothing here can prevent that.)
 */

import { useEffect, useRef, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { storeCredentialFromEntryLink } from "@/actions/agent-credential-entry.actions"
import { OutcomeCard, humanizeCredentialName } from "./outcome-card"

interface CredentialEntryFormProps {
  token: string
  credentialName: string
  ownerEmail: string
}

type FormState =
  | { phase: "entry"; error: string | null }
  | { phase: "stored"; action: "created" | "rotated" }
  | { phase: "already-used" }
  | { phase: "failed"; message: string }

/** The three ways this form ends. Hoisted so the form itself stays readable. */
function TerminalState({
  state,
  label,
  ownerEmail,
}: {
  state: Exclude<FormState, { phase: "entry" }>
  label: string
  ownerEmail: string
}) {
  if (state.phase === "stored") {
    return (
      <OutcomeCard
        title="Credential saved"
        testId="credential-entry-success"
        tone="neutral"
      >
        <p>
          Your <strong>{label}</strong> was{" "}
          {state.action === "rotated" ? "updated" : "stored"} securely for{" "}
          <strong>{ownerEmail}</strong>. Your agent can use it from now on and
          never needs to see the value itself.
        </p>
        <p>Head back to your chat with the agent and re-ask your question.</p>
        <p className="text-xs">
          This link is now spent. To replace or remove this value later, ask
          your agent for a new entry link.
        </p>
      </OutcomeCard>
    )
  }

  if (state.phase === "already-used") {
    return (
      <OutcomeCard title="Link already used" testId="credential-entry-used">
        <p className="text-center">
          This one-time link has already been used. Ask your agent for a fresh
          link if you need to store or replace the value.
        </p>
      </OutcomeCard>
    )
  }

  return (
    <OutcomeCard
      title="Could not save credential"
      testId="credential-entry-failed"
    >
      <p className="text-center">{state.message}</p>
    </OutcomeCard>
  )
}

export function CredentialEntryForm({
  token,
  credentialName,
  ownerEmail,
}: CredentialEntryFormProps) {
  const [value, setValue] = useState("")
  const [state, setState] = useState<FormState>({ phase: "entry", error: null })
  const [isPending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)
  // `isPending` only flips once React commits, so two submits dispatched in the
  // same task can both get through. The server's atomic nonce claim means only
  // one of them could ever write, and the UI cannot tell which one won — the
  // loser's "already-used" reply would tell the user their credential was not
  // stored when it was. So a second submit is never sent: this ref is set
  // synchronously, before the first await, and cleared when the reply lands.
  const inFlight = useRef(false)

  const errorMessage = state.phase === "entry" ? state.error : null
  // Put the cursor back where the fix has to happen. This waits for the
  // transition to settle on purpose: the input is `disabled` while the submit
  // is in flight, and focus() on a disabled element is a no-op. `role="alert"`
  // alone leaves a keyboard user hunting for what changed.
  useEffect(() => {
    if (errorMessage && !isPending) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [errorMessage, isPending])

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    const submitted = value
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof storeCredentialFromEntryLink>>
      try {
        result = await storeCredentialFromEntryLink(token, submitted)
      } finally {
        inFlight.current = false
      }

      if (!result.isSuccess) {
        setState({ phase: "failed", message: result.message })
        return
      }
      const outcome = result.data
      if (outcome.status === "invalid-value") {
        setState({ phase: "entry", error: outcome.reason })
        return
      }
      // Drop the value from component state the moment it is no longer
      // needed — nothing on this page reads it again.
      setValue("")
      if (outcome.status === "stored") {
        setState({ phase: "stored", action: outcome.action })
      } else if (outcome.status === "already-used") {
        setState({ phase: "already-used" })
      } else if (outcome.status === "not-configured") {
        setState({
          phase: "failed",
          message:
            "AI Studio is not set up to store credentials right now. This is a problem on our side, not with your link — tell the AI Studio team, then ask your agent for a new link.",
        })
      } else {
        setState({
          phase: "failed",
          message:
            outcome.status === "write-failed"
              ? "We could not save the credential. This link is now spent — ask your agent for a new one."
              : "This link can no longer be used. Ask your agent for a new one.",
        })
      }
    })
  }

  const label = humanizeCredentialName(credentialName)

  if (state.phase !== "entry") {
    return (
      <TerminalState state={state} label={label} ownerEmail={ownerEmail} />
    )
  }

  return (
    <>
      <CardHeader>
        <CardTitle className="text-center">Enter your {label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Your agent needs your <strong>{label}</strong> (
          <code className="text-xs">{credentialName}</code>). Enter it here
          rather than in the chat — it goes straight to encrypted storage, and
          neither the agent nor the chat transcript ever sees the value.
        </p>
        {/*
          Before the field, not after it: the user is about to leave for a
          vendor site to fetch the key, and finding out about the 15-minute
          window on their return is finding out too late.
        */}
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Have the value ready before you start — this link works once and
          expires 15 minutes after your agent created it. Your agent&apos;s
          message says where to find it.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="credential-value">Credential value</Label>
            <Input
              id="credential-value"
              ref={inputRef}
              data-testid="credential-entry-input"
              type="password"
              name="credentialValue"
              autoComplete="off"
              spellCheck={false}
              required
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={state.error ? true : undefined}
              aria-describedby={state.error ? "credential-value-error" : undefined}
              disabled={isPending}
            />
            {state.error ? (
              <p
                id="credential-value-error"
                role="alert"
                data-testid="credential-entry-error"
                className="text-sm text-red-700"
              >
                {state.error}
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            className="w-full"
            data-testid="credential-entry-submit"
            disabled={isPending || value.trim().length === 0}
          >
            {isPending ? "Saving…" : "Save credential"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Signed in as {ownerEmail}.
        </p>
      </CardContent>
    </>
  )
}
