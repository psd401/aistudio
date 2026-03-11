"use client"

import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from "react"
import { useSession } from "next-auth/react"
import { createLogger, generateRequestId } from "@/lib/client-logger"
import type { NotificationContextValue, UserNotification } from "@/types/notifications"
import { isConnectionTimeoutEvent, isNotificationUpdateEvent } from "@/types/notification-sse-events"

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
  const { status: sessionStatus } = useSession()
  const [notifications, setNotifications] = useState<UserNotification[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const consecutiveFailures = useRef(0)

  const log = createLogger({ component: 'NotificationProvider' })

  const fetchNotifications = useCallback(async () => {
    // Don't fetch if session is not authenticated
    if (sessionStatus !== 'authenticated') {
      return
    }

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
      consecutiveFailures.current = 0
      requestLog.info('Notifications fetched successfully', {
        count: data.data?.length || 0
      })
    } catch (err) {
      consecutiveFailures.current++
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      // Downgrade to warn — polling failures are expected transient states
      requestLog.warn('Failed to fetch notifications', {
        error: errorMessage,
        consecutiveFailures: consecutiveFailures.current
      })
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }, [sessionStatus])

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

  // Initial fetch on mount (only when authenticated)
  useEffect(() => {
    if (sessionStatus === 'authenticated') {
      fetchNotifications()
    }
  }, [fetchNotifications, sessionStatus])

  // Set up periodic refresh with exponential backoff on failures
  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      return
    }

    const baseInterval = 30000 // 30 seconds

    const getInterval = () => {
      if (consecutiveFailures.current === 0) return baseInterval
      // Exponential backoff: 1x, 2x, 4x, 8x cap
      const multiplier = Math.min(Math.pow(2, consecutiveFailures.current), 8)
      return baseInterval * multiplier
    }

    let timeoutId: NodeJS.Timeout

    const scheduleNext = () => {
      timeoutId = setTimeout(() => {
        if (!isLoading) {
          fetchNotifications().then(scheduleNext)
        } else {
          scheduleNext()
        }
      }, getInterval())
    }

    scheduleNext()

    return () => clearTimeout(timeoutId)
  }, [fetchNotifications, isLoading, sessionStatus])

  // Set up EventSource for real-time updates with exponential backoff
  useEffect(() => {
    let eventSource: EventSource | null = null
    let retryCount = 0
    let reconnectTimeoutId: NodeJS.Timeout | null = null
    let isHandlingReconnect = false // Prevent race condition between timeout and error handlers
    const maxRetries = 10
    const baseDelay = 5000 // 5 seconds

    const getBackoffDelay = (attempt: number) => {
      // Exponential backoff: 5s, 10s, 20s, 40s, then cap at 60s
      const delay = Math.min(baseDelay * Math.pow(2, attempt), 60000)
      // Add jitter (±25%) to prevent thundering herd
      const jitter = delay * 0.25 * (Math.random() - 0.5)
      return delay + jitter
    }

    // Centralized cleanup to prevent event listener leaks
    const cleanupEventSource = () => {
      if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId)
        reconnectTimeoutId = null
      }

      if (eventSource) {
        // Remove event listeners before closing to prevent leaks
        eventSource.close()
        eventSource = null
      }

      isHandlingReconnect = false
    }

    const setupEventSource = () => {
      // Clean up any existing connection first
      cleanupEventSource()

      if (retryCount >= maxRetries) {
        log.error('Max SSE retry attempts reached', { maxRetries })
        return
      }

      try {
        eventSource = new EventSource('/api/notifications/stream')

        eventSource.addEventListener('message', (event) => {
          try {
            const data = JSON.parse(event.data)

            // Reset retry count on successful message
            retryCount = 0

            if (isConnectionTimeoutEvent(data)) {
              // Server is gracefully closing — reconnect silently without backoff
              // Prevent race condition with error handler
              if (isHandlingReconnect) return

              isHandlingReconnect = true
              log.debug('SSE connection timeout, reconnecting', {
                retryCount,
                serverTimestamp: data.timestamp
              })
              cleanupEventSource()
              reconnectTimeoutId = setTimeout(setupEventSource, 1000)
              return
            }

            if (isNotificationUpdateEvent(data)) {
              log.info('Received notification update', {
                type: data.type,
                serverTimestamp: data.timestamp
              })
              fetchNotifications()
            }
          } catch (err) {
            log.error('Failed to parse SSE message', {
              error: err instanceof Error ? err.message : 'Unknown error'
            })
          }
        })

        eventSource.addEventListener('error', () => {
          // Prevent duplicate reconnection if timeout handler already scheduled one
          if (isHandlingReconnect) return

          isHandlingReconnect = true
          log.debug('SSE connection error, will retry', { retryCount })
          cleanupEventSource()

          // Increment retry count and setup retry with backoff
          retryCount++
          const delay = getBackoffDelay(retryCount - 1)

          log.info('Retrying SSE connection', {
            retryCount,
            delayMs: Math.round(delay),
            maxRetries
          })

          reconnectTimeoutId = setTimeout(setupEventSource, delay)
        })

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
        reconnectTimeoutId = setTimeout(setupEventSource, delay)
      }
    }

    // Only setup SSE if browser supports it and session is authenticated
    if (typeof EventSource !== 'undefined' && sessionStatus === 'authenticated') {
      setupEventSource()
    }

    return () => {
      cleanupEventSource()
    }
  }, [fetchNotifications, log, sessionStatus])

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