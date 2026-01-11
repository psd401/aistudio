"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Download, Clock, Calendar, AlertCircle, CheckCircle, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { PageBranding } from "@/components/ui/page-branding"

interface ExecutionResult {
  id: number
  scheduledExecutionId: number
  resultData: Record<string, unknown>
  status: 'success' | 'failed' | 'running'
  executedAt: string
  executionDurationMs: number
  errorMessage: string | null
  scheduleName: string
  userId: number
  assistantArchitectName: string
}

interface ExecutionResultClientProps {
  resultId: string
}

export function ExecutionResultClient({ resultId }: ExecutionResultClientProps) {
  const router = useRouter()
  const [result, setResult] = useState<ExecutionResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchExecutionResult() {
      try {
        const response = await fetch(`/api/execution-results/${resultId}`)

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("Execution result not found")
          }
          throw new Error(`Failed to fetch execution result: ${response.status}`)
        }

        const data = await response.json()
        setResult(data)

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to load execution result"
        setError(errorMessage)
        toast.error(errorMessage)
      } finally {
        setLoading(false)
      }
    }

    if (resultId) {
      fetchExecutionResult()
    }
  }, [resultId])

  const handleDownload = () => {
    if (!result) return

    const downloadUrl = `/api/execution-results/${result.id}/download`
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = `${result.scheduleName}-${new Date(result.executedAt).toISOString().slice(0, 10)}.md`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    toast.success("Download started")
  }

  const formatDuration = (durationMs: number) => {
    if (durationMs < 1000) {
      return `${durationMs}ms`
    }

    const seconds = Math.floor(durationMs / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`
    } else {
      return `${seconds}s`
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return <CheckCircle className="h-5 w-5 text-green-500" />
      case 'failed':
        return <AlertCircle className="h-5 w-5 text-red-500" />
      case 'running':
        return <RotateCcw className="h-5 w-5 text-blue-500 animate-spin" />
      default:
        return <div className="h-5 w-5 bg-gray-400 rounded-full" />
    }
  }

  const formatDateTime = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    })
  }

  const renderResultContent = (resultData: Record<string, unknown>) => {
    if (!resultData || Object.keys(resultData).length === 0) {
      return <p className="text-muted-foreground">No result data available</p>
    }

    // Try to extract main content
    if ('content' in resultData && typeof resultData.content === 'string') {
      return (
        <div className="prose prose-sm max-w-none">
          <pre className="whitespace-pre-wrap bg-muted p-4 rounded-md overflow-auto max-h-96">
            {resultData.content}
          </pre>
        </div>
      )
    } else if ('text' in resultData && typeof resultData.text === 'string') {
      return (
        <div className="prose prose-sm max-w-none">
          <pre className="whitespace-pre-wrap bg-muted p-4 rounded-md overflow-auto max-h-96">
            {resultData.text}
          </pre>
        </div>
      )
    } else if ('output' in resultData && typeof resultData.output === 'string') {
      return (
        <div className="prose prose-sm max-w-none">
          <pre className="whitespace-pre-wrap bg-muted p-4 rounded-md overflow-auto max-h-96">
            {resultData.output}
          </pre>
        </div>
      )
    } else {
      // Fallback to JSON representation
      return (
        <div className="prose prose-sm max-w-none">
          <pre className="whitespace-pre-wrap bg-muted p-4 rounded-md overflow-auto max-h-96 text-sm">
            {JSON.stringify(resultData, null, 2)}
          </pre>
        </div>
      )
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
        </div>
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <RotateCcw className="h-8 w-8 animate-spin mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">Loading execution result...</p>
          </div>
        </div>
      </div>
    )
  }

  if (error || !result) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
        </div>
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <AlertCircle className="h-8 w-8 mx-auto mb-4 text-red-500" />
            <p className="text-red-600">{error || "Execution result not found"}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <PageBranding />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" onClick={() => router.back()}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">{result.scheduleName}</h1>
              <p className="text-sm text-muted-foreground">{result.assistantArchitectName}</p>
            </div>
          </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={result.status === 'success' ? 'default' :
                     result.status === 'failed' ? 'destructive' : 'secondary'}
            className="flex items-center gap-1"
          >
            {getStatusIcon(result.status)}
            {result.status.charAt(0).toUpperCase() + result.status.slice(1)}
          </Badge>
          <Button onClick={handleDownload} size="sm">
            <Download className="h-4 w-4 mr-2" />
            Download
          </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-6">
        {/* Execution Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Execution Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Executed At</p>
                <p className="text-sm">{formatDateTime(result.executedAt)}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Duration</p>
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  <p className="text-sm">{formatDuration(result.executionDurationMs)}</p>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Result ID</p>
                <p className="text-sm font-mono">{result.id}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Error Message (if failed) */}
        {result.status === 'failed' && result.errorMessage && (
          <Card className="border-destructive">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                Error Message
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap bg-destructive/10 p-4 rounded-md text-sm">
                {result.errorMessage}
              </pre>
            </CardContent>
          </Card>
        )}

        {/* Results */}
        <Card>
          <CardHeader>
            <CardTitle>Results</CardTitle>
            <CardDescription>
              {result.status === 'success'
                ? "Execution completed successfully"
                : result.status === 'failed'
                ? "Execution failed"
                : "Execution in progress"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {renderResultContent(result.resultData)}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}