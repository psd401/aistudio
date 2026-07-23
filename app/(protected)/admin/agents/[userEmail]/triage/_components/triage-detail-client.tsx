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

  // Fire-and-forget load on mount + when refresh callback identity changes
  // (userEmail/toast change). The setState calls inside `refresh()` happen
  // AFTER an `await`, not synchronously in the effect tick, so the cascading
  // render the rule warns about doesn't actually occur here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
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
        void refresh()
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
      <Header state={state} onAction={setDialog} />
      <StatusCard state={state} />
      <EscalationCard state={state} />
      <SweepCard state={state} />
      {state.labels && <LabelsCard state={state} />}
      <CountsCard state={state} />
      <LearnedPatternsCard state={state} />
      <SuggestionsCard state={state} />
      <RecentDecisionsCard state={state} />
      {state.recentCorrections.length > 0 && <RecentCorrectionsCard state={state} />}
      <ConfirmDialog
        dialog={dialog}
        userEmail={userEmail}
        actionLoading={actionLoading}
        onClose={() => setDialog(null)}
        onConfirm={runAction}
      />
    </div>
  )
}

function Header({
  state,
  onAction,
}: {
  state: TriageStateSummary
  onAction: (k: Exclude<DialogKind, null>) => void
}) {
  return (
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
          onClick={() => onAction("pause")}
        >
          Pause
        </Button>
        <Button variant="secondary" onClick={() => onAction("reset")}>
          Reset learned
        </Button>
        <Button variant="destructive" onClick={() => onAction("reonboard")}>
          Force re-onboard
        </Button>
      </div>
    </div>
  )
}

function StatusCard({ state }: { state: TriageStateSummary }) {
  return (
    <SectionCard title="Status">
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
    </SectionCard>
  )
}

function EscalationCard({ state }: { state: TriageStateSummary }) {
  const blurb: Record<string, string> = {
    all: "Every Important classification pings the user's Chat (default).",
    "high-confidence":
      "Only rule matches and LLM decisions at/above the threshold ping Chat.",
    "rules-only":
      "Only VIP/escalation-rule matches ping Chat; plain LLM Important never does.",
    none: "Nothing pings Chat — the daily digest is the only surface.",
  }
  return (
    <SectionCard title="Escalation">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-3">
        <KeyVal k="Mode" v={state.escalationMode} />
        <KeyVal
          k="Confidence threshold"
          v={state.escalationConfidenceThreshold.toFixed(2)}
        />
        <KeyVal k="Escalation senders" v={state.counts.escalationSenders} />
        <KeyVal k="Escalation keywords" v={state.counts.escalationKeywords} />
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        {blurb[state.escalationMode] ?? ""}
      </p>
    </SectionCard>
  )
}

function SweepCard({ state }: { state: TriageStateSummary }) {
  const s = state.sweep
  return (
    <SectionCard title="Sweep">
      {s ? (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <KeyVal k="Status" v={s.status} />
          <KeyVal k="Progress" v={`${s.processed} / ${s.cap}`} />
          <KeyVal k="Labeled" v={s.labeled} />
          <KeyVal k="Window (days)" v={s.windowDays} />
          {s.updatedAt && <KeyVal k="Updated" v={s.updatedAt} />}
          {s.error && <KeyVal k="Error" v={s.error} />}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          No sweep has been run for this user.
        </p>
      )}
    </SectionCard>
  )
}

function LabelsCard({ state }: { state: TriageStateSummary }) {
  return (
    <SectionCard title="Labels">
      <div className="space-y-1 text-sm">
        {Object.entries(state.labels ?? {}).map(([k, name]) => (
          <div key={k} className="flex gap-3">
            <span className="w-24 text-muted-foreground">{k}</span>
            <span className="font-mono">{name}</span>
            <span className="font-mono text-muted-foreground">
              {state.labelIdsByKey?.[k] ?? ""}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

function CountsCard({ state }: { state: TriageStateSummary }) {
  const c = state.counts
  return (
    <SectionCard title="Counts">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
        <KeyVal k="VIPs" v={c.vipSenders} />
        <KeyVal k="Muted" v={c.muteSenders} />
        <KeyVal k="Keyword rules" v={c.keywordRules} />
        <KeyVal k="Escalation senders" v={c.escalationSenders} />
        <KeyVal k="Escalation keywords" v={c.escalationKeywords} />
        <KeyVal k="Recent decisions" v={c.recentDecisions} />
        <KeyVal k="Corrections" v={c.recentCorrections} />
        <KeyVal k="Learned patterns" v={c.learnedPatterns} />
        <KeyVal k="Pending suggestions" v={c.pendingSuggestions} />
      </dl>
    </SectionCard>
  )
}

function LearnedPatternsCard({ state }: { state: TriageStateSummary }) {
  return (
    <SectionCard title="Learned patterns">
      {state.learnedPatterns.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          (none yet — populated by the nightly learning job)
        </p>
      ) : (
        <div className="space-y-1 text-sm">
          {state.learnedPatterns.map((p) => (
            <div key={`${p.kind ?? "?"}-${p.pattern}`} className="flex gap-3">
              <span className="font-mono">{p.pattern}</span>
              <span className="text-muted-foreground">{p.kind ?? "?"}</span>
              <span className="text-muted-foreground">
                w={p.weight.toFixed(1)}
                {typeof p.count === "number" ? ` · ${p.count}×` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function SuggestionsCard({ state }: { state: TriageStateSummary }) {
  return (
    <SectionCard title="Pending suggestions">
      {state.pendingSuggestions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          (none — the user has no pending rule suggestions)
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          {state.pendingSuggestions.map((s) => (
            <div key={s.id} className="border-b py-2 last:border-0">
              <div className="flex justify-between">
                <span className="font-medium">{s.reason}</span>
                <span className="font-mono text-muted-foreground">{s.kind}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                id <span className="font-mono">{s.id}</span> · {s.count}× · w=
                {s.weight.toFixed(1)}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function RecentDecisionsCard({ state }: { state: TriageStateSummary }) {
  return (
    <SectionCard title="Recent decisions (newest first)">
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
    </SectionCard>
  )
}

function RecentCorrectionsCard({ state }: { state: TriageStateSummary }) {
  return (
    <SectionCard title="Recent corrections">
      <div className="space-y-2 text-sm">
        {state.recentCorrections.map((c) => (
          <div key={`${c.messageId}-${c.ts}`} className="border-b py-1 last:border-0">
            <span className="font-mono">{c.fromLabel}</span> →{" "}
            <span className="font-mono">{c.toLabel}</span>
            <span className="ml-2 text-xs text-muted-foreground">{c.ts}</span>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

function ConfirmDialog({
  dialog,
  userEmail,
  actionLoading,
  onClose,
  onConfirm,
}: {
  dialog: DialogKind
  userEmail: string
  actionLoading: boolean
  onClose: () => void
  onConfirm: (k: Exclude<DialogKind, null>) => void
}) {
  const copy: Record<Exclude<DialogKind, null>, { title: string; body: string }> = {
    pause: {
      title: "Pause triage?",
      body: `Stops the classifier for ${userEmail}. Rules and Gmail labels stay intact — they can re-enable from chat.`,
    },
    reset: {
      title: "Reset learned patterns?",
      body: `Clears learned patterns and correction history for ${userEmail}. Does not change user-authored rules or disable triage.`,
    },
    reonboard: {
      title: "Force re-onboard?",
      body: `Deletes the entire triage DDB row for ${userEmail}. Their Gmail labels and digest schedule are NOT deleted — they will need 'disable --forget' from chat to clean those up. Use this when the row is corrupt.`,
    },
  }
  const active = dialog ? copy[dialog] : null
  return (
    <AlertDialog open={dialog !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{active?.title}</AlertDialogTitle>
          <AlertDialogDescription>{active?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={actionLoading}
            onClick={(e) => {
              e.preventDefault()
              if (dialog) onConfirm(dialog)
            }}
          >
            {actionLoading ? "Working..." : "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function SectionCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
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
