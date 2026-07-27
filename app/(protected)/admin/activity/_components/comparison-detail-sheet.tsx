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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { format } from "date-fns"
import type {
  ComparisonActivityItem,
  ComparisonDetailItem,
} from "@/actions/admin/activity-management.actions"
import { getComparisonDetail } from "@/actions/admin/activity-management.actions"

interface ComparisonDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  comparison: ComparisonActivityItem | null
}

function useComparisonDetail(open: boolean, comparisonId?: number) {
  const { toast } = useToast()
  const [detail, setDetail] = useState<ComparisonDetailItem | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open || !comparisonId) {
      startTransition(() => { setDetail(null) })
      return
    }
    let cancelled = false
    startTransition(() => { setLoading(true) })
    void getComparisonDetail(comparisonId).then(result => {
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
  }, [open, comparisonId, toast])
  return { detail, loading }
}

export function ComparisonDetailSheet({
  open,
  onOpenChange,
  comparison,
}: ComparisonDetailSheetProps) {
  const { detail, loading } = useComparisonDetail(open, comparison?.id)

  if (!comparison) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-hidden flex flex-col">
        <SheetHeader>
          <SheetTitle>Model Comparison</SheetTitle>
          <SheetDescription>Comparison ID: {comparison.id}</SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="space-y-3 mt-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : (
          <ScrollArea className="flex-1 mt-6">
            <ComparisonDetailContent comparison={comparison} detail={detail} />
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  )
}

function ComparisonDetailContent({
  comparison,
  detail,
}: {
  comparison: ComparisonActivityItem
  detail: ComparisonDetailItem | null
}) {
  return (
    <div className="space-y-6 pr-4">
      <ComparisonOverview comparison={comparison} />
      <Separator />
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Prompt</h3>
        <div className="bg-muted p-3 rounded-md">
          <p className="text-sm whitespace-pre-wrap">{detail?.prompt || comparison.prompt}</p>
        </div>
      </div>
      <Separator />
      <ComparedModels comparison={comparison} />
      {(detail?.response1 || detail?.response2) && (
        <><Separator /><ComparisonResponses comparison={comparison} detail={detail} /></>
      )}
      {detail?.metadata && Object.keys(detail.metadata).length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Metadata</h3>
            <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-48">
              {JSON.stringify(detail.metadata, null, 2)}
            </pre>
          </div>
        </>
      )}
    </div>
  )
}

function ComparisonOverview({ comparison }: { comparison: ComparisonActivityItem }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Overview</h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-muted-foreground">User</span>
          <p className="font-medium">{comparison.userName}</p>
          <p className="text-xs text-muted-foreground">{comparison.userEmail}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Created</span>
          <p className="font-medium">
            {comparison.createdAt ? format(new Date(comparison.createdAt), "PPp") : "—"}
          </p>
        </div>
      </div>
    </div>
  )
}

function ComparedModels({ comparison }: { comparison: ComparisonActivityItem }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Models Compared</h3>
      <div className="grid grid-cols-2 gap-4">
        <ModelSummary
          name={comparison.model1Name || "Model 1"}
          tokens={comparison.tokensUsed1}
          executionTimeMs={comparison.executionTimeMs1}
        />
        <ModelSummary
          name={comparison.model2Name || "Model 2"}
          tokens={comparison.tokensUsed2}
          executionTimeMs={comparison.executionTimeMs2}
        />
      </div>
    </div>
  )
}

function ModelSummary({
  name,
  tokens,
  executionTimeMs,
}: {
  name: string
  tokens: number | null
  executionTimeMs: number | null
}) {
  return (
    <div className="space-y-2">
      <Badge variant="outline" className="mb-2">{name}</Badge>
      <div className="text-xs text-muted-foreground space-y-1">
        <p>Tokens: {tokens?.toLocaleString() ?? "—"}</p>
        <p>Time: {executionTimeMs ? `${executionTimeMs}ms` : "—"}</p>
      </div>
    </div>
  )
}

function ComparisonResponses({
  comparison,
  detail,
}: {
  comparison: ComparisonActivityItem
  detail: ComparisonDetailItem
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Responses</h3>
      <Tabs defaultValue="model1" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="model1">{comparison.model1Name || "Model 1"}</TabsTrigger>
          <TabsTrigger value="model2">{comparison.model2Name || "Model 2"}</TabsTrigger>
        </TabsList>
        <ResponseTab value="model1" response={detail.response1} />
        <ResponseTab value="model2" response={detail.response2} />
      </Tabs>
    </div>
  )
}

function ResponseTab({ value, response }: { value: string; response: string | null }) {
  return (
    <TabsContent value={value} className="mt-3">
      <div className="bg-muted p-3 rounded-md max-h-64 overflow-auto">
        <p className="text-sm whitespace-pre-wrap">{response || "(No response)"}</p>
      </div>
    </TabsContent>
  )
}
