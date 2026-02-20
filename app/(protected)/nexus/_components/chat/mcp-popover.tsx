'use client'

import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Plug, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import {
  getConnectorsWithStatus,
  type ConnectorWithStatus,
} from '@/actions/mcp-connector.actions'
import { openOAuthPopup } from './oauth-popup'
import type { McpConnectionStatus } from '@/lib/mcp/connector-types'

interface MCPPopoverProps {
  enabledConnectors: string[]
  onConnectorsChange: (connectors: string[]) => void
  disabled?: boolean
  /** Called after successful OAuth reconnect — used to dismiss reconnect prompt.
   *  TODO: Consider React Context to avoid prop drilling through thread → composer → popover. */
  onReconnectSuccess?: (serverId: string) => void
}

/** Status indicator dot colors */
const STATUS_COLORS: Record<McpConnectionStatus, string> = {
  connected: 'bg-green-500',
  token_expired: 'bg-yellow-500',
  no_token: 'bg-gray-400',
}

const STATUS_LABELS: Record<McpConnectionStatus, string> = {
  connected: 'Connected',
  token_expired: 'Token expired',
  no_token: 'Not connected',
}

interface ConnectorItemProps {
  connector: ConnectorWithStatus
  isEnabled: boolean
  isAuthenticating: boolean
  onToggle: (connectorId: string) => void
  onReconnect: (connectorId: string) => void
}

const ConnectorItem = memo(function ConnectorItem({
  connector,
  isEnabled,
  isAuthenticating,
  onToggle,
  onReconnect,
}: ConnectorItemProps) {
  const handleClick = useCallback(() => {
    if (isAuthenticating) return
    onToggle(connector.id)
  }, [connector.id, isAuthenticating, onToggle])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!isAuthenticating) onToggle(connector.id)
    }
  }, [connector.id, isAuthenticating, onToggle])

  const handleReconnect = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onReconnect(connector.id)
  }, [connector.id, onReconnect])

  return (
    <div
      role="switch"
      aria-checked={isEnabled}
      aria-label={`${connector.name} connector — ${STATUS_LABELS[connector.status]}`}
      tabIndex={0}
      className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50 cursor-pointer"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium truncate">{connector.name}</p>
            <span
              aria-hidden="true"
              className={cn('h-1.5 w-1.5 rounded-full shrink-0', STATUS_COLORS[connector.status])}
            />
          </div>
          <div className="flex items-center gap-1">
            <p className="text-xs text-muted-foreground truncate">
              {STATUS_LABELS[connector.status]}
            </p>
            {connector.status === 'token_expired' && !isAuthenticating && (
              <button
                type="button"
                onClick={handleReconnect}
                className="text-xs text-primary hover:underline shrink-0"
                aria-label={`Reconnect ${connector.name}`}
              >
                Reconnect
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1">
        {isAuthenticating && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
        {/* Visual toggle indicator — row handles interaction via role="switch" */}
        <Switch
          checked={isEnabled}
          tabIndex={-1}
          aria-hidden="true"
          disabled={isAuthenticating}
          className="shrink-0 pointer-events-none"
        />
      </div>
    </div>
  )
})

export function MCPPopover({
  enabledConnectors,
  onConnectorsChange,
  disabled = false,
  onReconnectSuccess,
}: MCPPopoverProps) {
  const [connectors, setConnectors] = useState<ConnectorWithStatus[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [authenticatingIds, setAuthenticatingIds] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  // Refs to avoid stale closures in async callbacks
  const enabledConnectorsRef = useRef(enabledConnectors)
  const onConnectorsChangeRef = useRef(onConnectorsChange)

  useEffect(() => {
    enabledConnectorsRef.current = enabledConnectors
    onConnectorsChangeRef.current = onConnectorsChange
  })

  // Load connectors when popover opens (refreshes on every open)
  useEffect(() => {
    if (!open) return

    let cancelled = false
    setIsLoading(true)
    setLoadError(false)

    getConnectorsWithStatus().then((result) => {
      if (cancelled) return
      if (result.isSuccess) {
        setConnectors(result.data)

        // Remove any enabled connectors that are no longer accessible
        const availableIds = result.data.map((c) => c.id)
        const current = enabledConnectorsRef.current
        const valid = current.filter((id) => availableIds.includes(id))
        if (valid.length !== current.length) {
          onConnectorsChangeRef.current(valid)
        }
      } else {
        setLoadError(true)
      }
    }).finally(() => {
      if (!cancelled) setIsLoading(false)
    })

    return () => { cancelled = true }
  }, [open, retryCount])

  /**
   * Shared OAuth flow — used by both toggle-on and reconnect.
   * On success: updates connector status to 'connected' and auto-enables.
   */
  const performOAuth = useCallback(async (connectorId: string, toastPrefix: string) => {
    setAuthenticatingIds((prev) => new Set([...prev, connectorId]))
    try {
      const result = await openOAuthPopup(connectorId)
      if (result.success) {
        setConnectors((prev) =>
          prev.map((c) =>
            c.id === connectorId ? { ...c, status: 'connected' as const } : c
          )
        )
        const latest = enabledConnectorsRef.current
        if (!latest.includes(connectorId)) {
          onConnectorsChangeRef.current([...latest, connectorId])
        }
        // Dismiss reconnect prompt after successful re-auth (Bug #3 fix)
        if (onReconnectSuccess) {
          onReconnectSuccess(connectorId)
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed'
      toast.error(`${toastPrefix} failed`, { description: message })
    } finally {
      setAuthenticatingIds((prev) => {
        const next = new Set(prev)
        next.delete(connectorId)
        return next
      })
    }
  }, [onReconnectSuccess])

  const handleToggle = useCallback(async (connectorId: string) => {
    // Guard against double-clicks while OAuth popup is already open
    if (authenticatingIds.has(connectorId)) return

    const connector = connectors.find((c) => c.id === connectorId)
    if (!connector) return

    const currentEnabled = enabledConnectorsRef.current

    if (currentEnabled.includes(connectorId)) {
      onConnectorsChangeRef.current(currentEnabled.filter((id) => id !== connectorId))
      return
    }

    // Enable — check if OAuth is needed
    const needsOAuth =
      connector.authType !== 'none' &&
      (connector.status === 'no_token' || connector.status === 'token_expired')

    if (needsOAuth) {
      await performOAuth(connectorId, 'Connection')
      return
    }

    // No auth needed — enable directly
    const latest = enabledConnectorsRef.current
    if (!latest.includes(connectorId)) {
      onConnectorsChangeRef.current([...latest, connectorId])
    }
  }, [connectors, authenticatingIds, performOAuth])

  const handleReconnect = useCallback(async (connectorId: string) => {
    await performOAuth(connectorId, 'Reconnection')
  }, [performOAuth])

  const enabledCount = enabledConnectors.length
  const hasConnectors = connectors.length > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 gap-1.5 text-xs',
            enabledCount > 0 && 'text-primary'
          )}
          disabled={disabled}
          title={disabled ? 'Select a model first' : 'Configure connections'}
        >
          <Plug className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Connect</span>
          {enabledCount > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-xs">
              {enabledCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="p-3 border-b">
          <h4 className="font-medium text-sm">Connections</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            Connect to external services via MCP
          </p>
        </div>
        <div className="p-2">
          {isLoading ? (
            <div className="flex items-center justify-center p-4 gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">Loading connectors...</span>
            </div>
          ) : loadError ? (
            <div className="p-2 text-center">
              <p className="text-xs text-destructive">Failed to load connectors</p>
              <button
                type="button"
                onClick={() => setRetryCount((c) => c + 1)}
                className="text-xs text-primary hover:underline mt-1"
              >
                Retry
              </button>
            </div>
          ) : !hasConnectors ? (
            <p className="text-xs text-muted-foreground p-2 text-center">
              No connectors available
            </p>
          ) : (
            <div className="space-y-1">
              {connectors.map((connector) => (
                <ConnectorItem
                  key={connector.id}
                  connector={connector}
                  isEnabled={enabledConnectors.includes(connector.id)}
                  isAuthenticating={authenticatingIds.has(connector.id)}
                  onToggle={handleToggle}
                  onReconnect={handleReconnect}
                />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
