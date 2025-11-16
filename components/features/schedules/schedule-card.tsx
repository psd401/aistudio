"use client"

import { useState, memo, useCallback } from "react"
// No date-fns imports needed - using native Date
import {
  Calendar,
  Clock,
  Play,
  Pause,
  Trash2,
  Edit,
  CheckCircle,
  XCircle,
  Loader,
  MoreHorizontal
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Schedule } from "@/actions/db/schedule-actions"
import { ScheduleEditModal } from "./schedule-edit-modal"

interface ScheduleCardProps {
  schedule: Schedule
  onDelete: (id: number) => Promise<void>
  onToggle: (id: number, currentActive: boolean) => Promise<void>
  onRefresh: () => Promise<void>
}

function ScheduleCardComponent({ schedule, onDelete, onToggle, onRefresh }: ScheduleCardProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const [isToggling, setIsToggling] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)

  const handleCloseModal = useCallback(() => {
    setShowEditModal(false)
  }, [])

  const handleModalSuccess = useCallback(() => {
    setShowEditModal(false)
    // Use setTimeout to prevent rapid state updates
    setTimeout(() => {
      onRefresh()
    }, 0)
  }, [onRefresh])

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await onDelete(schedule.id)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleToggle = async () => {
    setIsToggling(true)
    try {
      await onToggle(schedule.id, schedule.active)
    } finally {
      setIsToggling(false)
    }
  }

  // Utility function to format time consistently using browser timezone
  const formatTimeForDisplay = (time: string): string => {
    try {
      const [hours, minutes] = time.split(":").map(Number)
      const date = new Date()
      date.setHours(hours, minutes, 0, 0)

      return date.toLocaleString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
      })
    } catch {
      return time
    }
  }

  const formatScheduleDescription = (scheduleConfig: Schedule["scheduleConfig"]) => {
    const { frequency, time, daysOfWeek, dayOfMonth } = scheduleConfig
    const formattedTime = formatTimeForDisplay(time)

    switch (frequency) {
      case "daily":
        return `Every day at ${formattedTime}`
      case "weekly":
        if (daysOfWeek && daysOfWeek.length > 0) {
          const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
          const days = daysOfWeek.map(day => dayNames[day]).join(", ")
          return `Every ${days} at ${formattedTime}`
        }
        return `Weekly at ${formattedTime}`
      case "monthly":
        return `Monthly on day ${dayOfMonth || 1} at ${formattedTime}`
      case "custom":
        return `Custom schedule at ${formattedTime}`
      default:
        return `${frequency} at ${formattedTime}`
    }
  }

  const getStatusBadge = () => {
    if (!schedule.active) {
      return <Badge variant="secondary" className="gap-1"><Pause className="h-3 w-3" />Paused</Badge>
    }

    if (schedule.lastExecution) {
      if (schedule.lastExecution.status === "success") {
        return <Badge variant="default" className="gap-1 bg-green-600"><CheckCircle className="h-3 w-3" />Active</Badge>
      } else if (schedule.lastExecution.status === "failed") {
        return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Failed</Badge>
      }
    }

    return <Badge variant="default" className="gap-1 bg-blue-600"><Play className="h-3 w-3" />Active</Badge>
  }

  const getNextExecutionText = () => {
    if (!schedule.active) {
      return "Paused"
    }

    // Calculate next execution time client-side
    const { scheduleConfig } = schedule
    const { frequency, time, daysOfWeek, dayOfMonth, cron } = scheduleConfig

    if (!time || !frequency) {
      return "Next execution time will be calculated"
    }

    try {
      const now = new Date()
      const [hours, minutes] = time.split(":").map(Number)

      const nextRun = new Date()
      nextRun.setHours(hours, minutes, 0, 0)

      // If time has passed today, move to next occurrence
      if (nextRun <= now) {
        switch (frequency) {
          case "daily":
            nextRun.setDate(nextRun.getDate() + 1)
            break
          case "weekly":
            if (daysOfWeek?.length) {
              const currentDay = now.getDay()
              const nextDay = daysOfWeek.find(day => day > currentDay) || daysOfWeek[0]
              const daysToAdd = nextDay > currentDay ? nextDay - currentDay : 7 - currentDay + nextDay
              nextRun.setDate(nextRun.getDate() + daysToAdd)
            }
            break
          case "monthly":
            if (dayOfMonth) {
              nextRun.setMonth(nextRun.getMonth() + 1)
              nextRun.setDate(dayOfMonth)
            }
            break
          case "custom":
            return cron ? `Custom: ${cron}` : "Custom schedule"
        }
      }

      return nextRun.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })
    } catch {
      return "Next execution time will be calculated"
    }
  }

  const getLastExecutionText = () => {
    if (!schedule.lastExecution) {
      return "No executions yet"
    }

    try {
      const utcDate = new Date(schedule.lastExecution.executedAt)

      // Verify it's a valid date
      if (Number.isNaN(utcDate.getTime())) {
        return `${schedule.lastExecution.status} - Invalid date`
      }

      const statusIcon = schedule.lastExecution.status === "success"
        ? <CheckCircle className="h-3 w-3 text-green-600" />
        : <XCircle className="h-3 w-3 text-red-600" />

      // Format in local timezone (browser automatically handles the conversion)
      const formattedDate = utcDate.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
      })

      return (
        <div className="flex items-center gap-1">
          {statusIcon}
          <span className="capitalize">{schedule.lastExecution.status}</span>
          <span className="text-muted-foreground">
            {formattedDate}
          </span>
        </div>
      )
    } catch {
      return `${schedule.lastExecution.status} - Invalid date`
    }
  }

  return (
    <>
      <Card className="hover:shadow-md transition-shadow">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <CardTitle className="text-lg mb-1 flex items-center gap-2">
                {schedule.name}
                {getStatusBadge()}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {formatScheduleDescription(schedule.scheduleConfig)}
              </p>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setShowEditModal(true)}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleToggle} disabled={isToggling}>
                  {isToggling ? (
                    <Loader className="h-4 w-4 mr-2 animate-spin" />
                  ) : schedule.active ? (
                    <Pause className="h-4 w-4 mr-2" />
                  ) : (
                    <Play className="h-4 w-4 mr-2" />
                  )}
                  {schedule.active ? "Pause" : "Resume"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Schedule</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to delete the schedule &quot;{schedule.name}&quot;?
                        This action cannot be undone and will stop all future executions.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDelete}
                        disabled={isDeleting}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        {isDeleting ? (
                          <>
                            <Loader className="h-4 w-4 mr-2 animate-spin" />
                            Deleting...
                          </>
                        ) : (
                          "Delete Schedule"
                        )}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>

        <CardContent className="pt-0">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Next Execution</span>
              </div>
              <p className="text-muted-foreground">{getNextExecutionText()}</p>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-1">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Last Execution</span>
              </div>
              <div className="text-muted-foreground">{getLastExecutionText()}</div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="flex items-center gap-2 mt-4 pt-4 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowEditModal(true)}
              className="gap-1"
            >
              <Edit className="h-3 w-3" />
              Edit
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleToggle}
              disabled={isToggling}
              className="gap-1"
            >
              {isToggling ? (
                <Loader className="h-3 w-3 animate-spin" />
              ) : schedule.active ? (
                <Pause className="h-3 w-3" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              {schedule.active ? "Pause" : "Resume"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <ScheduleEditModal
        schedule={schedule}
        open={showEditModal}
        onClose={handleCloseModal}
        onSuccess={handleModalSuccess}
      />
    </>
  )
}

// Memoize the component to prevent unnecessary re-renders
export const ScheduleCard = memo(ScheduleCardComponent)