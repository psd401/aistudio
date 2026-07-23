"use client"

import { useCallback, useEffect, useState } from "react"
import {
  getRepositoryItemManagementView,
  type RepositoryItemManagementView,
} from "@/actions/repositories/repository-management.actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { formatRepositorySourceLocator } from "@/lib/repositories/citation-label"
import {
  AlertCircle,
  Box,
  Clock3,
  FileStack,
  Loader2,
  MapPin,
} from "lucide-react"
import { format } from "date-fns"

interface RepositoryItemDetailsProps {
  itemId: number
}

function formatBytes(value: number | null): string {
  if (value == null) return "Unknown size"
  if (value < 1024) return `${value} B`
  const units = ["KB", "MB", "GB", "TB"]
  let size = value / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024
    unit = units[index]
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`
}

function statusVariant(
  status: string
): "default" | "secondary" | "destructive" | "outline" {
  if (["completed", "succeeded", "active", "available", "clean"].includes(status)) {
    return "default"
  }
  if (["failed", "blocked", "error", "cancelled"].includes(status)) {
    return "destructive"
  }
  if (["processing", "running", "queued", "pending"].includes(status)) {
    return "secondary"
  }
  return "outline"
}

function StatusBadge({ value }: { value: string }) {
  return (
    <Badge variant={statusVariant(value)} className="capitalize">
      {value.replaceAll("_", " ")}
    </Badge>
  )
}

export function RepositoryItemDetails({
  itemId,
}: RepositoryItemDetailsProps) {
  const [details, setDetails] =
    useState<RepositoryItemManagementView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const result = await getRepositoryItemManagementView(itemId)
    if (result.isSuccess && result.data) {
      setDetails(result.data)
    } else {
      setDetails(null)
      setError(result.message || "Repository item details are unavailable")
    }
    setLoading(false)
  }, [itemId])

  useEffect(() => {
    let cancelled = false
    async function loadInitialDetails() {
      const result = await getRepositoryItemManagementView(itemId)
      if (cancelled) return
      if (result.isSuccess && result.data) {
        setDetails(result.data)
      } else {
        setDetails(null)
        setError(result.message || "Repository item details are unavailable")
      }
      setLoading(false)
    }
    void loadInitialDetails()
    return () => {
      cancelled = true
    }
  }, [itemId])

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading source history…
      </div>
    )
  }

  if (!details || error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Item details unavailable</AlertTitle>
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>{error}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLoading(true)
              setError(null)
              void load()
            }}
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  const currentVersion = details.versions.find((version) => version.isCurrent)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{details.itemName}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Source</dt>
              <dd className="mt-1 break-all font-medium">
                {details.sourceSummary}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Current version</dt>
              <dd className="mt-1 font-medium">
                {currentVersion
                  ? `Version ${currentVersion.versionNumber}`
                  : "Legacy source pending canonical processing"}
              </dd>
            </div>
            {currentVersion ? (
              <>
                <div>
                  <dt className="text-muted-foreground">Media type</dt>
                  <dd className="mt-1">
                    {currentVersion.detectedContentType ||
                      currentVersion.declaredContentType ||
                      "Unknown"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Size</dt>
                  <dd className="mt-1">{formatBytes(currentVersion.byteSize)}</dd>
                </div>
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Tabs defaultValue="versions">
        <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4">
          <TabsTrigger value="versions">
            <FileStack className="mr-2 h-4 w-4" />
            Versions
          </TabsTrigger>
          <TabsTrigger value="processing">
            <Clock3 className="mr-2 h-4 w-4" />
            Processing
          </TabsTrigger>
          <TabsTrigger value="artifacts">
            <Box className="mr-2 h-4 w-4" />
            Artifacts
          </TabsTrigger>
          <TabsTrigger value="citations">
            <MapPin className="mr-2 h-4 w-4" />
            Citations
          </TabsTrigger>
        </TabsList>

        <TabsContent value="versions" className="space-y-3">
          {details.versions.length === 0 ? (
            <p className="rounded-md border p-4 text-sm text-muted-foreground">
              This legacy source does not have immutable version history yet.
            </p>
          ) : (
            details.versions.map((version) => (
              <Card key={version.id}>
                <CardContent className="space-y-3 pt-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      Version {version.versionNumber}
                    </span>
                    {version.isCurrent ? <Badge>Current</Badge> : null}
                    <StatusBadge value={version.processingStatus} />
                    <StatusBadge value={version.inspectionStatus} />
                  </div>
                  <dl className="grid gap-3 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Source type</dt>
                      <dd className="mt-1 capitalize">
                        {version.sourceKind.replaceAll("_", " ")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Created</dt>
                      <dd className="mt-1">{format(version.createdAt, "PPpp")}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Storage</dt>
                      <dd className="mt-1">
                        <StatusBadge value={version.storageStatus} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Checksum</dt>
                      <dd className="mt-1 truncate font-mono">
                        {version.sha256 || "Pending"}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="processing" className="space-y-3">
          {details.jobs.length === 0 ? (
            <p className="rounded-md border p-4 text-sm text-muted-foreground">
              No canonical processing jobs are recorded for this source.
            </p>
          ) : (
            details.jobs.map((job) => (
              <Card key={job.id}>
                <CardContent className="space-y-2 pt-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium capitalize">{job.stage}</span>
                    <StatusBadge value={job.status} />
                    <span className="text-xs text-muted-foreground">
                      Attempt {job.attempt} of {job.maxAttempts}
                    </span>
                  </div>
                  {job.lastErrorMessage ? (
                    <p className="text-sm text-destructive">
                      {job.lastErrorCode ? `${job.lastErrorCode}: ` : ""}
                      {job.lastErrorMessage}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Updated {format(job.updatedAt, "PPpp")}
                  </p>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="artifacts" className="space-y-3">
          {details.artifacts.length === 0 ? (
            <p className="rounded-md border p-4 text-sm text-muted-foreground">
              No derived artifacts have been published yet.
            </p>
          ) : (
            details.artifacts.map((artifact) => (
              <div
                key={artifact.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
              >
                <div>
                  <p className="font-medium capitalize">
                    {artifact.kind.replaceAll("_", " ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {artifact.mediaType} · {artifact.processorName}{" "}
                    {artifact.processorVersion}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {format(artifact.createdAt, "PP")}
                </span>
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="citations" className="space-y-3">
          {details.citations.length === 0 ? (
            <p className="rounded-md border p-4 text-sm text-muted-foreground">
              Citation locators appear after this source is included in the
              active repository index.
            </p>
          ) : (
            details.citations.map((citation) => {
              const label =
                formatRepositorySourceLocator(citation.sourceLocator) ||
                `Chunk ${citation.chunkIndex + 1}`
              return (
                <div
                  key={citation.chunkId}
                  className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    <span>{label}</span>
                  </div>
                  <Badge variant="outline" className="capitalize">
                    {citation.modality}
                  </Badge>
                </div>
              )
            })
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
