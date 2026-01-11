"use client"

import { useState, useEffect } from "react"
import { Plus, Calendar, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { PageBranding } from "@/components/ui/page-branding"
import { toast } from "sonner"
import { createLogger, generateRequestId } from "@/lib/client-logger"
import type { Schedule } from "@/actions/db/schedule-actions"
import { ScheduleCard } from "@/components/features/schedules/schedule-card"
import { ErrorBoundary } from "@/components/error-boundary"
import Link from "next/link"

const log = createLogger({ component: "SchedulesClient" })

export function SchedulesClient() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadSchedules = async () => {
    const requestId = generateRequestId()
    log.info("Loading schedules", { requestId })

    try {
      setIsLoading(true)
      setError(null)

      const response = await fetch("/api/schedules")

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || "Failed to load schedules")
      }

      const data = await response.json()
      setSchedules(data)
      log.info("Schedules loaded successfully", { requestId, count: data.length })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to load schedules"
      log.error("Failed to load schedules", { requestId, error: errorMessage })
      setError(errorMessage)
      toast.error("Failed to load schedules", {
        description: errorMessage
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleDeleteSchedule = async (id: number) => {
    const requestId = generateRequestId()
    log.info("Deleting schedule", { requestId, scheduleId: id })

    try {
      const response = await fetch(`/api/schedules/${id}`, {
        method: "DELETE"
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || "Failed to delete schedule")
      }

      // Remove from local state
      setSchedules(prev => prev.filter(schedule => schedule.id !== id))

      log.info("Schedule deleted successfully", { requestId, scheduleId: id })
      toast.success("Schedule deleted successfully")
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to delete schedule"
      log.error("Failed to delete schedule", { requestId, scheduleId: id, error: errorMessage })
      toast.error("Failed to delete schedule", {
        description: errorMessage
      })
    }
  }

  const handleToggleSchedule = async (id: number, currentActive: boolean) => {
    const requestId = generateRequestId()
    const action = currentActive ? "pause" : "resume"
    log.info(`${action} schedule`, { requestId, scheduleId: id })

    try {
      const response = await fetch(`/api/schedules/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          active: !currentActive
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || `Failed to ${action} schedule`)
      }

      const updatedSchedule = await response.json()

      // Update local state
      setSchedules(prev => prev.map(schedule =>
        schedule.id === id ? updatedSchedule : schedule
      ))

      log.info(`Schedule ${action}d successfully`, { requestId, scheduleId: id })
      toast.success(`Schedule ${action}d successfully`)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : `Failed to ${action} schedule`
      log.error(`Failed to ${action} schedule`, { requestId, scheduleId: id, error: errorMessage })
      toast.error(`Failed to ${action} schedule`, {
        description: errorMessage
      })
    }
  }

  useEffect(() => {
    loadSchedules()
  }, [])

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <PageBranding />
            <h1 className="text-2xl font-semibold text-gray-900">Schedule Management</h1>
            <p className="text-sm text-muted-foreground mt-1">Manage your automated Assistant Architect executions</p>
          </div>
        </div>

        <div className="grid gap-4">
          {[1, 2, 3].map(i => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-6 bg-muted rounded w-1/3" />
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="h-4 bg-muted rounded w-1/2" />
                  <div className="h-4 bg-muted rounded w-1/4" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <PageBranding />
            <h1 className="text-2xl font-semibold text-gray-900">Schedule Management</h1>
            <p className="text-sm text-muted-foreground mt-1">Manage your automated Assistant Architect executions</p>
          </div>
        </div>

        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <p className="font-medium">Failed to load schedules</p>
            </div>
            <p className="text-muted-foreground mt-2">{error}</p>
            <Button
              onClick={loadSchedules}
              className="mt-4"
              variant="outline"
            >
              Try Again
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <PageBranding />
          <h1 className="text-2xl font-semibold text-gray-900">Schedule Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your automated Assistant Architect executions
          </p>
        </div>

        <Button asChild>
          <Link href="/utilities/assistant-architect" className="gap-2">
            <Plus className="h-4 w-4" />
            Create New Schedule
          </Link>
        </Button>
      </div>

      {/* Schedules List */}
      {schedules.length === 0 ? (
        <Card className="text-center py-12">
          <CardContent>
            <Calendar className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No schedules found</h3>
            <p className="text-muted-foreground mb-6">
              Create your first automated execution schedule to get started.
            </p>
            <Button asChild>
              <Link href="/utilities/assistant-architect" className="gap-2">
                <Plus className="h-4 w-4" />
                Create Schedule
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {schedules.map(schedule => (
            <ErrorBoundary
              key={schedule.id}
              fallback={({ reset }) => (
                <Card className="border-destructive">
                  <CardContent className="pt-6">
                    <div className="flex items-center gap-2 text-destructive">
                      <AlertCircle className="h-5 w-5" />
                      <p className="font-medium">Error loading schedule</p>
                    </div>
                    <p className="text-muted-foreground mt-2">
                      Schedule &quot;{schedule.name}&quot; could not be displayed properly.
                    </p>
                    <Button onClick={reset} className="mt-4" variant="outline" size="sm">
                      Try Again
                    </Button>
                  </CardContent>
                </Card>
              )}
            >
              <ScheduleCard
                schedule={schedule}
                onDelete={handleDeleteSchedule}
                onToggle={handleToggleSchedule}
                onRefresh={loadSchedules}
              />
            </ErrorBoundary>
          ))}
        </div>
      )}
    </div>
  )
}