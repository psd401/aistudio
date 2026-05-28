"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useToast } from "@/components/ui/use-toast"
import {
  listAgentConversations,
  getAgentConversationDetail,
  type ConversationListItem,
  type ConversationDetail,
} from "@/actions/admin/agent-conversations.actions"
import { formatDate } from "@/lib/date-utils"

const DAYS_OPTIONS = [
  { value: "1", label: "Last 24h" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
]

export function AgentConversationsTab() {
  const { toast } = useToast()
  const [items, setItems] = useState<ConversationListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState<string>("7")
  const [userFilter, setUserFilter] = useState("")
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listAgentConversations(
        Number(days),
        userFilter.trim() || undefined,
      )
      if (r.isSuccess && r.data) {
        setItems(r.data)
      } else {
        toast({
          title: "Failed to load conversations",
          description: r.message,
          variant: "destructive",
        })
      }
    } finally {
      setLoading(false)
    }
  }, [days, userFilter, toast])

  useEffect(() => {
    load()
  }, [load])

  const openSession = useCallback(
    async (sessionId: string) => {
      setSelectedSession(sessionId)
      setDetailLoading(true)
      setDetail(null)
      try {
        const r = await getAgentConversationDetail(sessionId)
        if (r.isSuccess && r.data) {
          setDetail(r.data)
        } else if (r.isSuccess) {
          // null data = session not found
          setDetail(null)
        } else {
          toast({
            title: "Failed to load session",
            description: r.message,
            variant: "destructive",
          })
        }
      } finally {
        setDetailLoading(false)
      }
    },
    [toast],
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conversations</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Full transcripts + tool invocations per session. 90-day retention
            on content; the per-turn metadata (above, in Usage) is kept
            longer. Admin-only.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-[160px] h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="h-8 text-sm w-[260px]"
              placeholder="Filter by user (email/id)"
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") load()
              }}
            />
            <Button variant="outline" size="sm" onClick={load}>
              Apply
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-48 w-full" />
          ) : items.length === 0 ? (
            <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
              No conversations in the selected window.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Last turn</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Turns</TableHead>
                  <TableHead className="text-right">Tools</TableHead>
                  <TableHead className="text-right">Tokens (in/out)</TableHead>
                  <TableHead>Models</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => (
                  <TableRow key={s.sessionId}>
                    <TableCell className="text-xs">
                      {formatDate(s.lastTurnAt, true)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.userId}</TableCell>
                    <TableCell className="text-right">{s.turnCount}</TableCell>
                    <TableCell className="text-right">
                      {s.toolCallCount}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs">
                      {s.totalInputTokens.toLocaleString()} /{" "}
                      {s.totalOutputTokens.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs">
                      {s.models.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        s.models.map((m) => (
                          <Badge
                            key={m}
                            variant="outline"
                            className="text-[10px] py-0 mr-1"
                          >
                            {m}
                          </Badge>
                        ))
                      )}
                    </TableCell>
                    <TableCell>
                      {s.hasError ? (
                        <Badge variant="destructive">guardrail</Badge>
                      ) : (
                        <Badge variant="secondary">ok</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openSession(s.sessionId)}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet
        open={selectedSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSession(null)
            setDetail(null)
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Session detail</SheetTitle>
            <SheetDescription className="font-mono text-xs break-all">
              {selectedSession}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            {detailLoading && <Skeleton className="h-40 w-full" />}
            {!detailLoading && detail === null && selectedSession && (
              <div className="text-sm text-muted-foreground">
                Session not found. It may have aged out of the 90-day window,
                or no content was captured for this session (older messages
                predate the deep-telemetry rollout).
              </div>
            )}
            {!detailLoading && detail && (
              <ConversationDetailView detail={detail} />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function ConversationDetailView({ detail }: { detail: ConversationDetail }) {
  return (
    <div className="space-y-6">
      <div className="text-xs text-muted-foreground">
        User: <span className="font-mono">{detail.userId}</span> ·{" "}
        {detail.turns.length} turn{detail.turns.length === 1 ? "" : "s"}
      </div>
      {detail.turns.length === 0 && (
        <div className="text-sm text-muted-foreground">
          No turns recorded — agent_messages has a row but no content was
          captured. This is normal for sessions that started before the
          deep-telemetry writers shipped.
        </div>
      )}
      {detail.turns.map((turn, i) => (
        <div key={turn.messageId} className="border rounded p-3 space-y-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">
                Turn {i + 1}
              </Badge>
              <span>{formatDate(turn.createdAt, true)}</span>
              {turn.model && (
                <Badge variant="secondary" className="text-[10px] py-0">
                  {turn.model}
                </Badge>
              )}
            </div>
            <div className="space-x-2">
              <span>{turn.latencyMs} ms</span>
              <span>
                {turn.inputTokens.toLocaleString()} in /{" "}
                {turn.outputTokens.toLocaleString()} out
              </span>
            </div>
          </div>
          {turn.messages.length === 0 && (
            <div className="text-xs text-muted-foreground italic">
              No content captured for this turn (pre-rollout).
            </div>
          )}
          {turn.messages.map((m, mi) => (
            <div key={mi} className="space-y-1">
              <Badge
                variant={m.role === "user" ? "default" : "secondary"}
                className="text-[10px] py-0"
              >
                {m.role}
              </Badge>
              <pre className="text-xs whitespace-pre-wrap break-words bg-muted/40 rounded p-2">
                {m.contentText}
                {m.contentTruncated && (
                  <span className="text-muted-foreground">… [truncated]</span>
                )}
              </pre>
            </div>
          ))}
          {turn.tools.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Tool calls
              </div>
              {turn.tools.map((t, ti) => (
                <details key={ti} className="text-xs border rounded p-2">
                  <summary className="cursor-pointer flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] py-0">
                      {t.toolName}
                    </Badge>
                    <span className="text-muted-foreground">
                      {t.durationMs} ms ·{" "}
                    </span>
                    {t.status === "success" ? (
                      <Badge variant="secondary" className="text-[10px] py-0">
                        success
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[10px] py-0">
                        {t.status}
                      </Badge>
                    )}
                  </summary>
                  {t.errorText && (
                    <pre className="mt-2 text-xs text-destructive whitespace-pre-wrap">
                      {t.errorText}
                    </pre>
                  )}
                  {t.toolArgs && (
                    <div className="mt-2">
                      <div className="text-muted-foreground">args:</div>
                      <pre className="text-[11px] bg-muted/40 rounded p-1 overflow-auto">
                        {JSON.stringify(t.toolArgs, null, 2)}
                      </pre>
                    </div>
                  )}
                  {t.toolResult && (
                    <div className="mt-2">
                      <div className="text-muted-foreground">result:</div>
                      <pre className="text-[11px] bg-muted/40 rounded p-1 overflow-auto">
                        {JSON.stringify(t.toolResult, null, 2)}
                      </pre>
                    </div>
                  )}
                </details>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
