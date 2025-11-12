"use client"

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react"
import { createLogger, generateRequestId } from "@/lib/client-logger"
import type { NotificationContextValue, UserNotification } from "@/types/notifications"

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined)

export function useNotifications() {
  const context = useContext(NotificationContext)
  if (context === undefined) {
    throw new Error('useNotifications must be used within a NotificationProvider')
  }
  return context
}

interface NotificationProviderProps {
  children: ReactNode
}

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [notifications, setNotifications] = useState<UserNotification[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const log = createLogger({ component: 'NotificationProvider' })

  const fetchNotifications = useCallback(async () => {
    const requestId = generateRequestId()
    const requestLog = createLogger({ component: 'NotificationProvider', requestId })

    try {
      requestLog.info('Fetching notifications')
      setError(null)

      const response = await fetch('/api/notifications', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        // If unauthorized, just return empty notifications instead of throwing
        if (response.status === 401) {
          setNotifications([])
          setIsLoading(false)
          return
        }
        throw new Error(`Failed to fetch notifications: ${response.status}`)
      }

      const data = await response.json()

      if (!data.isSuccess) {
        throw new Error(data.message || 'Failed to fetch notifications')
      }

      setNotifications(data.data || [])
      requestLog.info('Notifications fetched successfully', {
        count: data.data?.length || 0
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      requestLog.error('Failed to fetch notifications', { error: errorMessage })
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const markAsRead = useCallback(async (notificationId: number) => {
    const requestId = generateRequestId()
    const requestLog = createLogger({ component: 'NotificationProvider', requestId })

    try {
      requestLog.info('Marking notification as read', { notificationId })

      const response = await fetch(`/api/notifications/${notificationId}/read`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        if (response.status === 401) {
          return // Silently fail for unauthenticated users
        }
        throw new Error(`Failed to mark notification as read: ${response.status}`)
      }

      const data = await response.json()

      if (!data.isSuccess) {
        throw new Error(data.message || 'Failed to mark notification as read')
      }

      // Update local state optimistically
      setNotifications(prev =>
        prev.map(notification =>
          notification.id === notificationId
            ? { ...notification, status: 'read' as const }
            : notification
        )
      )

      requestLog.info('Notification marked as read successfully', { notificationId })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      requestLog.error('Failed to mark notification as read', {
        error: errorMessage,
        notificationId
      })
      setError(errorMessage)

      // Refresh notifications to get correct state
      await fetchNotifications()
    }
  }, [fetchNotifications])

  const markAllAsRead = useCallback(async () => {
    const requestId = generateRequestId()
    const requestLog = createLogger({ component: 'NotificationProvider', requestId })

    try {
      requestLog.info('Marking all notifications as read')

      const response = await fetch('/api/notifications/read-all', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        if (response.status === 401) {
          return // Silently fail for unauthenticated users
        }
        throw new Error(`Failed to mark all notifications as read: ${response.status}`)
      }

      const data = await response.json()

      if (!data.isSuccess) {
        throw new Error(data.message || 'Failed to mark all notifications as read')
      }

      // Update local state optimistically
      setNotifications(prev =>
        prev.map(notification => ({ ...notification, status: 'read' as const }))
      )

      requestLog.info('All notifications marked as read successfully')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      requestLog.error('Failed to mark all notifications as read', { error: errorMessage })
      setError(errorMessage)

      // Refresh notifications to get correct state
      await fetchNotifications()
    }
  }, [fetchNotifications])

  const refreshNotifications = useCallback(async () => {
    await fetchNotifications()
  }, [fetchNotifications])

  // Calculate unread count
  const unreadCount = notifications.filter(
    notification => notification.status !== 'read'
  ).length

  // Initial fetch on mount
  useEffect(() => {
    fetchNotifications()
  }, [fetchNotifications])

  // Set up periodic refresh (every 30 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      if (!isLoading) {
        fetchNotifications()
      }
    }, 30000)

    return () => clearInterval(interval)
  }, [fetchNotifications, isLoading])

  // Set up EventSource for real-time updates with exponential backoff
  useEffect(() => {
    let eventSource: EventSource | null = null
    let retryCount = 0
    const maxRetries = 10
    const baseDelay = 5000 // 5 seconds

    const getBackoffDelay = (attempt: number) => {
      // Exponential backoff: 5s, 10s, 20s, 40s, then cap at 60s
      const delay = Math.min(baseDelay * Math.pow(2, attempt), 60000)
      // Add jitter (±25%) to prevent thundering herd
      const jitter = delay * 0.25 * (Math.random() - 0.5)
      return delay + jitter
    }

    const setupEventSource = () => {
      if (retryCount >= maxRetries) {
        log.error('Max SSE retry attempts reached', { maxRetries })
        return
      }

      try {
        eventSource = new EventSource('/api/notifications/stream')

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            log.info('Received notification update', { type: data.type })

            // Reset retry count on successful message
            retryCount = 0

            if (data.type === 'notification_update') {
              // Refresh notifications when we get an update
              fetchNotifications()
            }
          } catch (err) {
            log.error('Failed to parse SSE message', {
              error: err instanceof Error ? err.message : 'Unknown error'
            })
          }
        }

        eventSource.onerror = (event) => {
          log.warn('SSE connection error, will retry', { event, retryCount })
          eventSource?.close()

          // Increment retry count and setup retry with backoff
          retryCount++
          const delay = getBackoffDelay(retryCount - 1)

          log.info('Retrying SSE connection', {
            retryCount,
            delayMs: Math.round(delay),
            maxRetries
          })

          setTimeout(setupEventSource, delay)
        }

        eventSource.addEventListener('open', () => {
          log.info('SSE connection established', { retryCount })
          // Reset retry count on successful connection
          retryCount = 0
        })
      } catch (err) {
        log.error('Failed to setup SSE connection', {
          error: err instanceof Error ? err.message : 'Unknown error',
          retryCount
        })

        // Increment retry count and setup retry with backoff
        retryCount++
        const delay = getBackoffDelay(retryCount - 1)
        setTimeout(setupEventSource, delay)
      }
    }

    // Only setup SSE if browser supports it
    if (typeof EventSource !== 'undefined') {
      setupEventSource()
    }

    return () => {
      if (eventSource) {
        eventSource.close()
      }
    }
  }, [fetchNotifications, log])

  const value: NotificationContextValue = {
    notifications,
    unreadCount,
    isLoading,
    error,
    markAsRead,
    markAllAsRead,
    refreshNotifications,
  }

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  )
}