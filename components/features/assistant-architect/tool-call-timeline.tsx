"use client"

import { CheckCircle2, Loader2, XCircle, Wrench, ShieldAlert } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { ToolTimelineEvent } from "./assistant-architect-streaming"

interface ToolCallTimelineProps {
  events: ToolTimelineEvent[]
}

/**
 * Renders the agentic tool-call timeline (Issue #926): one row per tool call,
 * showing the tool name, status (running / done / error), and any output/error
 * detail. Driven by the SSE tool-call lifecycle events the agent loop emits.
 * Hidden until the first tool call arrives so prompt-chain-style runs (or agentic
 * runs that never call a tool) show nothing.
 */
export function ToolCallTimeline({ events }: ToolCallTimelineProps) {
  if (events.length === 0) return null

  return (
    <Card data-testid="tool-call-timeline">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Wrench className="h-4 w-4" />
          Tool calls
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <ol className="space-y-2">
          {events.map((event, idx) => (
            <li
              key={event.toolCallId || idx}
              className="flex items-start gap-2 text-sm"
              data-testid="tool-call-timeline-item"
            >
              <PhaseIcon phase={event.phase} />
              <div className="min-w-0">
                <span className="font-medium">{event.toolName}</span>
                {event.detail && (
                  <p className="truncate text-xs text-muted-foreground">
                    {event.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}

function PhaseIcon({ phase }: { phase: ToolTimelineEvent["phase"] }) {
  if (phase === "output") {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-label="completed" />
  }
  if (phase === "error") {
    return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-label="error" />
  }
  if (phase === "confirmation") {
    // Destructive tool gated pending human approval (#926).
    return <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-label="awaiting confirmation" />
  }
  return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-label="running" />
}
