"use client"

import { useEffect, useState, startTransition } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/use-toast"
import { format } from "date-fns"
import type {
  ExecutionActivityItem,
  ExecutionDetailItem,
} from "@/actions/admin/activity-management.actions"
import { getExecutionDetail } from "@/actions/admin/activity-management.actions"

interface ExecutionDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  execution: ExecutionActivityItem | null
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "completed" || status === "success"
      ? "default"
      : status === "error" || status === "failed"
        ? "destructive"
        : status === "running" || status === "in_progress"
          ? "secondary"
          : "outline"

  return <Badge variant={variant}>{status}</Badge>
}

export function ExecutionDetailSheet({
  open,
  onOpenChange,
  execution,
}: ExecutionDetailSheetProps) {
  const { toast } = useToast()
  const [detail, setDetail] = useState<ExecutionDetailItem | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open && execution?.id) {
      let cancelled = false
      startTransition(() => { setLoading(true) })

      getExecutionDetail(execution.id).then(result => {
        if (cancelled) return
        if (result.isSuccess && result.data) {
          setDetail(result.data)
        } else {
          toast({
            variant: "destructive",
            title: "Error loading details",
            description: result.message,
          })
        }
        setLoading(false)
      })

      return () => { cancelled = true }
    } else {
      startTransition(() => { setDetail(null) })
    }
  }, [open, execution?.id, toast])

  if (!execution) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-hidden flex flex-col">
        <SheetHeader>
          <SheetTitle className="truncate">{execution.assistantName}</SheetTitle>
          <SheetDescription>Execution ID: {execution.id}</SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="space-y-3 mt-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : (
          <ScrollArea className="flex-1 mt-6">
            <div className="space-y-6 pr-4">
              {/* Overview Section */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Overview</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">User</span>
                    <p className="font-medium">{execution.userName}</p>
                    <p className="text-xs text-muted-foreground">
                      {execution.userEmail}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Status</span>
                    <div className="mt-1">
                      <StatusBadge status={execution.status} />
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Schedule</span>
                    <p className="font-medium">{execution.scheduleName}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Duration</span>
                    <p className="font-medium">
                      {execution.executionDurationMs
                        ? execution.executionDurationMs < 1000
                          ? `${execution.executionDurationMs}ms`
                          : `${(execution.executionDurationMs / 1000).toFixed(1)}s`
                        : "—"}
                    </p>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Executed At</span>
                    <p className="font-medium">
                      {execution.executedAt
                        ? format(new Date(execution.executedAt), "PPp")
                        : "—"}
                    </p>
                  </div>
                </div>
              </div>

              {detail?.assistantDescription && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Assistant Description</h3>
                    <p className="text-sm text-muted-foreground">
                      {detail.assistantDescription}
                    </p>
                  </div>
                </>
              )}

              {execution.errorMessage && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-destructive">
                      Error
                    </h3>
                    <p className="text-sm bg-destructive/10 p-3 rounded-md font-mono">
                      {execution.errorMessage}
                    </p>
                  </div>
                </>
              )}

              {detail?.inputData &&
                Object.keys(detail.inputData).length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">Input Data</h3>
                      <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-48">
                        {JSON.stringify(detail.inputData, null, 2)}
                      </pre>
                    </div>
                  </>
                )}

              {detail?.resultData &&
                Object.keys(detail.resultData).length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">Result Data</h3>
                      <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-64">
                        {JSON.stringify(detail.resultData, null, 2)}
                      </pre>
                    </div>
                  </>
                )}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  )
}
