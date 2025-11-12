"use client"

import { useState, useMemo, useCallback } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Loader2, Calendar, Clock, Globe } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { DialogFooter } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import type { AssistantArchitectWithRelations } from "@/types/assistant-architect-types"
import type { ScheduleConfig } from "@/actions/db/schedule-actions"

// Common timezones
const COMMON_TIMEZONES = [
  { value: "America/New_York", label: "Eastern Time (EST/EDT)" },
  { value: "America/Chicago", label: "Central Time (CST/CDT)" },
  { value: "America/Denver", label: "Mountain Time (MST/MDT)" },
  { value: "America/Los_Angeles", label: "Pacific Time (PST/PDT)" },
  { value: "UTC", label: "UTC" },
]

// Days of week for weekly schedules
const DAYS_OF_WEEK = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
]

const scheduleSchema = z.object({
  name: z.string().min(1, "Schedule name is required").max(1000, "Name must be 1000 characters or less"),
  frequency: z.enum(["daily", "weekly", "monthly", "custom"]),
  time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Invalid time format (HH:MM)"),
  timezone: z.string().min(1, "Please select a timezone"),
  daysOfWeek: z.array(z.number()).optional(),
  dayOfMonth: z.number().min(1).max(31).optional(),
  cron: z.string().optional(),
})

type ScheduleFormData = z.infer<typeof scheduleSchema>

interface ScheduleFormProps {
  tool: AssistantArchitectWithRelations
  inputData: Record<string, unknown>
  onSuccess: () => void
  onCancel: () => void
}

export function ScheduleForm({ tool, inputData, onSuccess, onCancel }: ScheduleFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { toast } = useToast()

  // Get user's timezone as default
  const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const defaultTimezone = COMMON_TIMEZONES.find(tz => tz.value === userTimezone)?.value || "America/New_York"

  const form = useForm<ScheduleFormData>({
    resolver: zodResolver(scheduleSchema),
    defaultValues: {
      name: `${tool.name} - Daily`,
      frequency: "daily",
      time: "09:00",
      timezone: defaultTimezone,
      daysOfWeek: [1, 2, 3, 4, 5], // Monday-Friday by default
      dayOfMonth: 1,
      cron: "",
    },
  })

  const frequency = form.watch("frequency")
  const time = form.watch("time")
  const timezone = form.watch("timezone")
  const daysOfWeek = form.watch("daysOfWeek")
  const dayOfMonth = form.watch("dayOfMonth")
  const cron = form.watch("cron")

  const onSubmit = async (data: ScheduleFormData) => {
    setIsSubmitting(true)

    try {
      const scheduleConfig: ScheduleConfig = {
        frequency: data.frequency,
        time: data.time,
        timezone: data.timezone,
      }

      // Add frequency-specific fields
      if (data.frequency === "weekly") {
        scheduleConfig.daysOfWeek = data.daysOfWeek || []
      }

      if (data.frequency === "monthly") {
        scheduleConfig.dayOfMonth = data.dayOfMonth || 1
      }

      if (data.frequency === "custom") {
        scheduleConfig.cron = data.cron || ""
      }

      // Client-side validation
      if (!data.name.trim()) {
        throw new Error("Schedule name is required")
      }

      if (!tool.id || isNaN(Number(tool.id))) {
        throw new Error("Invalid assistant architect ID")
      }

      if (!inputData || typeof inputData !== 'object') {
        throw new Error("Invalid input data")
      }

      if (!scheduleConfig.frequency || !scheduleConfig.time) {
        throw new Error("Invalid schedule configuration")
      }

      // Validate frequency-specific requirements
      if (data.frequency === "weekly") {
        if (!data.daysOfWeek || data.daysOfWeek.length === 0) {
          throw new Error("Please select at least one day for weekly schedules")
        }
      }

      if (data.frequency === "monthly") {
        if (!data.dayOfMonth || data.dayOfMonth < 1 || data.dayOfMonth > 31) {
          throw new Error("Please select a valid day of month (1-31) for monthly schedules")
        }
      }

      if (data.frequency === "custom") {
        if (!data.cron || data.cron.trim() === "") {
          throw new Error("Please enter a cron expression for custom schedules")
        }
      }

      // Filter out empty string values from inputData
      const filteredInputData = Object.entries(inputData).reduce((acc, [key, value]) => {
        if (value !== "" && value != null && value !== undefined) {
          acc[key] = value
        }
        return acc
      }, {} as Record<string, unknown>)

      const requestPayload = {
        name: data.name,
        assistantArchitectId: Number(tool.id),
        scheduleConfig,
        inputData: filteredInputData,
      }

      // API call to create schedule

      const response = await fetch("/api/schedules", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestPayload),
      })

      const result = await response.json()

      if (!response.ok) {
        console.error("Schedule creation failed:", {
          status: response.status,
          statusText: response.statusText,
          error: result
        })

        // Extract specific error messages for better user feedback
        let errorMessage = `Server error: ${response.status} ${response.statusText}`

        if (result.message) {
          errorMessage = result.message
        } else if (result.error?.message) {
          errorMessage = result.error.message
        } else if (result.error?.details?.fields?.length > 0) {
          // Show specific field validation errors with improved formatting
          const fieldErrors = result.error.details.fields.map((field: { field?: string, message: string }) => {
            // For validation errors, show just the message without "Validation failed:" prefix
            return field.message
          }).join('\n')
          errorMessage = fieldErrors
        }

        throw new Error(errorMessage)
      }

      toast({
        title: "Schedule Created",
        description: `"${data.name}" has been scheduled successfully.`,
      })

      onSuccess()
    } catch (error) {
      console.error("Failed to create schedule:", error)
      toast({
        title: "Failed to Create Schedule",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const getNextRunPreview = useCallback(() => {
    if (!time || !frequency) return null

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
            return cron ? `Custom: ${cron}` : null
        }
      }

      return nextRun.toLocaleString("en-US", {
        timeZone: timezone,
        weekday: "long",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })
    } catch {
      return null
    }
  }, [frequency, time, timezone, daysOfWeek, dayOfMonth, cron])

  const nextRunPreview = useMemo(() => getNextRunPreview(), [getNextRunPreview])

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Schedule Name */}
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Schedule Name</FormLabel>
              <FormControl>
                <Input
                  placeholder="Enter a name for this schedule"
                  {...field}
                  className="bg-muted"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Frequency */}
        <FormField
          control={form.control}
          name="frequency"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Frequency</FormLabel>
              <FormControl>
                <RadioGroup
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                  className="grid grid-cols-2 gap-4"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="daily" id="daily" />
                    <Label htmlFor="daily">Daily</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="weekly" id="weekly" />
                    <Label htmlFor="weekly">Weekly</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="monthly" id="monthly" />
                    <Label htmlFor="monthly">Monthly</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="custom" id="custom" />
                    <Label htmlFor="custom">Custom</Label>
                  </div>
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Time */}
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="time"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Time
                </FormLabel>
                <FormControl>
                  <Input
                    type="time"
                    {...field}
                    className="bg-muted"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Timezone */}
          <FormField
            control={form.control}
            name="timezone"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  Timezone
                </FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger className="bg-muted">
                      <SelectValue placeholder="Select timezone" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {COMMON_TIMEZONES.map((tz) => (
                      <SelectItem key={tz.value} value={tz.value}>
                        {tz.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Weekly specific fields */}
        {frequency === "weekly" && (
          <FormField
            control={form.control}
            name="daysOfWeek"
            render={() => (
              <FormItem>
                <FormLabel>Days of Week</FormLabel>
                <div className="grid grid-cols-4 gap-2">
                  {DAYS_OF_WEEK.map((day) => (
                    <FormField
                      key={day.value}
                      control={form.control}
                      name="daysOfWeek"
                      render={({ field }) => {
                        return (
                          <FormItem
                            key={day.value}
                            className="flex flex-row items-start space-x-3 space-y-0"
                          >
                            <FormControl>
                              <Checkbox
                                checked={field.value?.includes(day.value)}
                                onCheckedChange={(checked) => {
                                  const currentValue = field.value || []
                                  if (checked) {
                                    field.onChange([...currentValue, day.value].sort())
                                  } else {
                                    field.onChange(currentValue.filter((value) => value !== day.value))
                                  }
                                }}
                              />
                            </FormControl>
                            <FormLabel className="text-sm font-normal">
                              {day.label}
                            </FormLabel>
                          </FormItem>
                        )
                      }}
                    />
                  ))}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* Monthly specific fields */}
        {frequency === "monthly" && (
          <FormField
            control={form.control}
            name="dayOfMonth"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Day of Month</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min="1"
                    max="31"
                    placeholder="1"
                    {...field}
                    onChange={(e) => field.onChange(Number.parseInt(e.target.value) || 1)}
                    className="bg-muted"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* Custom cron fields */}
        {frequency === "custom" && (
          <FormField
            control={form.control}
            name="cron"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Cron Expression</FormLabel>
                <FormControl>
                  <Input
                    placeholder="0 9 * * 1-5 (9 AM on weekdays)"
                    {...field}
                    className="bg-muted font-mono"
                  />
                </FormControl>
                <p className="text-xs text-muted-foreground">
                  Format: minute hour day month day-of-week (0-6, 0=Sunday)
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* Preview */}
        {nextRunPreview && (
          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-1">
              <Calendar className="h-4 w-4" />
              Next Run Preview
            </div>
            <p className="text-sm">{nextRunPreview}</p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Calendar className="mr-2 h-4 w-4" />
                Create Schedule
              </>
            )}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}