"use client"

import { useCallback, useEffect, useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/use-toast"
import {
  forceReonboard,
  getTriageState,
  pauseTriage,
  resetLearnedPatterns,
  type TriageStateSummary,
} from "@/actions/admin/agent-triage.actions"

interface Props {
  userEmail: string
}

type DialogKind = null | "pause" | "reset" | "reonboard"

export function TriageDetailClient({ userEmail }: Props) {
  const { toast } = useToast()
  const [state, setState] = useState<TriageStateSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [dialog, setDialog] = useState<DialogKind>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const r = await getTriageState(userEmail)
    if (r.isSuccess) {
      setState(r.data)
    } else {
      toast({
        title: "Failed to load triage state",
        description: r.message,
        variant: "destructive",
      })
    }
    setLoading(false)
  }, [userEmail, toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const runAction = useCallback(
    async (kind: Exclude<DialogKind, null>) => {
      setActionLoading(true)
      const handler =
        kind === "pause"
          ? pauseTriage
          : kind === "reset"
            ? resetLearnedPatterns
            : forceReonboard
      const r = await handler(userEmail)
      setActionLoading(false)
      setDialog(null)
      if (r.isSuccess) {
        toast({ title: "Success", description: r.message })
        refresh()
      } else {
        toast({
          title: "Failed",
          description: r.message,
          variant: "destructive",
        })
      }
    },
    [userEmail, toast, refresh],
  )

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Email Triage · {userEmail}</h1>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!state) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Email Triage · {userEmail}</h1>
        <Card>
          <CardContent className="pt-6 text-muted-foreground">
            No triage row for this user. They have not enabled triage yet, or it
            has been forcefully reset.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Email Triage · {state.userEmail}</h1>
          <p className="text-sm text-muted-foreground">
            Read-only admin view. User-facing operations happen in chat.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={!state.enabled}
            onClick={() => setDialog("pause")}
          >
            Pause
          </Button>
          <Button variant="secondary" onClick={() => setDialog("reset")}>
            Reset learned
          </Button>
          <Button variant="destructive" onClick={() => setDialog("reonboard")}>
            Force re-onboard
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-3">
            <KeyVal k="Enabled" v={state.enabled ? "Yes" : "No"} />
            {state.enabledAt && <KeyVal k="Enabled at" v={state.enabledAt} />}
            {state.disabledAt && <KeyVal k="Disabled at" v={state.disabledAt} />}
            {state.lastPollAt && <KeyVal k="Last poll" v={state.lastPollAt} />}
            <KeyVal k="lastHistoryId" v={state.lastHistoryId ?? "(unset)"} />
            <KeyVal
              k="Digest"
              v={
                state.digest?.enabled
                  ? `${state.digest.time ?? "?"} ${state.digest.tz ?? ""}`
                  : "off"
              }
            />
          </dl>
        </CardContent>
      </Card>

      {state.labels && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Labels</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {Object.entries(state.labels).map(([k, name]) => (
              <div key={k} className="flex gap-3">
                <span className="w-24 text-muted-foreground">{k}</span>
                <span className="font-mono">{name}</span>
                <span className="font-mono text-muted-foreground">
                  {state.labelIdsByKey?.[k] ?? ""}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Counts</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
            <KeyVal k="VIPs" v={state.counts.vipSenders} />
            <KeyVal k="Muted" v={state.counts.muteSenders} />
            <KeyVal k="Keyword rules" v={state.counts.keywordRules} />
            <KeyVal k="Escalation senders" v={state.counts.escalationSenders} />
            <KeyVal k="Escalation keywords" v={state.counts.escalationKeywords} />
            <KeyVal k="Recent decisions" v={state.counts.recentDecisions} />
            <KeyVal k="Corrections" v={state.counts.recentCorrections} />
            <KeyVal k="Learned patterns" v={state.counts.learnedPatterns} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent decisions (newest first)</CardTitle>
        </CardHeader>
        <CardContent>
          {state.recentDecisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">(none yet)</p>
          ) : (
            <div className="space-y-2 text-sm">
              {state.recentDecisions.map((d) => (
                <div key={d.messageId} className="border-b py-2 last:border-0">
                  <div className="flex justify-between">
                    <span className="font-medium">{d.subject || "(no subject)"}</span>
                    <span className="font-mono text-muted-foreground">{d.label}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {d.fromEmail} · {d.source} · confidence {d.confidence.toFixed(2)} · {d.reason}
                  </div>
                  <div className="text-xs text-muted-foreground">{d.ts}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {state.recentCorrections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent corrections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              {state.recentCorrections.map((c) => (
                <div key={`${c.messageId}-${c.ts}`} className="border-b py-1 last:border-0">
                  <span className="font-mono">{c.fromLabel}</span> →{" "}
                  <span className="font-mono">{c.toLabel}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{c.ts}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog === "pause" && "Pause triage?"}
              {dialog === "reset" && "Reset learned patterns?"}
              {dialog === "reonboard" && "Force re-onboard?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialog === "pause" &&
                `Stops the classifier for ${userEmail}. Rules and Gmail labels stay intact — they can re-enable from chat.`}
              {dialog === "reset" &&
                `Clears learned patterns and correction history for ${userEmail}. Does not change user-authored rules or disable triage.`}
              {dialog === "reonboard" &&
                `Deletes the entire triage DDB row for ${userEmail}. Their Gmail labels and digest schedule are NOT deleted — they will need 'disable --forget' from chat to clean those up. Use this when the row is corrupt.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={actionLoading}
              onClick={(e) => {
                e.preventDefault()
                if (dialog) runAction(dialog)
              }}
            >
              {actionLoading ? "Working..." : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function KeyVal({ k, v }: { k: string; v: string | number | null | undefined }) {
  return (
    <div>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-mono">{v ?? "—"}</dd>
    </div>
  )
}
