/**
 * Shared chrome for the credential-entry page (issue #1887).
 *
 * The page (a server component) and the form (a client component) both render
 * terminal states that are the same card with different copy, so the shell
 * lives here rather than being hand-rolled in each of the eight branches.
 * No hooks, so either runtime can import it.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function EntryLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-4">
      {/*
        A page that asks for an API key has to say whose page it is. Staff are
        (rightly) taught to distrust "paste your key here" prompts, and without
        a name there is nothing here to tell a real entry link apart from a
        phishing copy of it.
      */}
      <p className="mb-3 text-sm font-semibold tracking-tight text-muted-foreground">
        PSD AI Studio
      </p>
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  )
}

export function OutcomeCard({
  title,
  testId,
  tone = "error",
  children,
}: {
  title: string
  testId?: string
  tone?: "error" | "neutral"
  children: React.ReactNode
}) {
  return (
    <>
      <CardHeader>
        <CardTitle
          className={`text-center${tone === "error" ? " text-red-600" : ""}`}
          data-testid={testId}
        >
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        {children}
      </CardContent>
    </>
  )
}

/**
 * Turn a credential slot name into something a non-developer recognises:
 * `freshservice_api_key` -> `Freshservice API Key`. The raw slot name is still
 * shown alongside, because that is what the agent said in chat.
 */
export function humanizeCredentialName(name: string): string {
  const ACRONYMS = new Set(["api", "id", "url", "pat", "sso"])
  return name
    .split(/[_.-]+/)
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(" ")
}
