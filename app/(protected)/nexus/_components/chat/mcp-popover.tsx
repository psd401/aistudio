'use client'

import { useState, useEffect, useCallback, useRef, memo, startTransition } from 'react'
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
  const needsAuth = connector.status === 'no_token' || connector.status === 'token_expired'

  const handleClick = useCallback(() => {
    onToggle(connector.id)
  }, [connector.id, onToggle])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle(connector.id)
    }
  }, [connector.id, onToggle])

  const handleSwitchClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  const handleReconnect = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onReconnect(connector.id)
  }, [connector.id, onReconnect])

  return (
    <div
      role="button"
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
              className={cn('h-1.5 w-1.5 rounded-full shrink-0', STATUS_COLORS[connector.status])}
              title={STATUS_LABELS[connector.status]}
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
        <Switch
          checked={isEnabled}
          onCheckedChange={handleClick}
          onClick={handleSwitchClick}
          disabled={isAuthenticating || (needsAuth && connector.authType !== 'none')}
          className="shrink-0"
        />
      </div>
    </div>
  )
})

export function MCPPopover({
  enabledConnectors,
  onConnectorsChange,
  disabled = false,
}: MCPPopoverProps) {
  const [connectors, setConnectors] = useState<ConnectorWithStatus[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [authenticatingIds, setAuthenticatingIds] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState(false)

  // Refs to avoid stale closures
  const enabledConnectorsRef = useRef(enabledConnectors)
  const onConnectorsChangeRef = useRef(onConnectorsChange)

  useEffect(() => {
    enabledConnectorsRef.current = enabledConnectors
    onConnectorsChangeRef.current = onConnectorsChange
  })

  // Load connectors on mount
  useEffect(() => {
    let cancelled = false

    startTransition(() => { setIsLoading(true) })

    getConnectorsWithStatus().then((result) => {
      if (cancelled) return
      if (result.isSuccess) {
        setConnectors(result.data)

        // Remove any enabled connectors that are no longer available
        const availableIds = result.data.map((c) => c.id)
        const current = enabledConnectorsRef.current
        const valid = current.filter((id) => availableIds.includes(id))
        if (valid.length !== current.length) {
          onConnectorsChangeRef.current(valid)
        }
      }
    }).finally(() => {
      if (!cancelled) setIsLoading(false)
    })

    return () => { cancelled = true }
  }, [])

  const handleToggle = useCallback(async (connectorId: string) => {
    const connector = connectors.find((c) => c.id === connectorId)
    if (!connector) return

    if (enabledConnectors.includes(connectorId)) {
      // Disable — simple removal
      onConnectorsChange(enabledConnectors.filter((id) => id !== connectorId))
      return
    }

    // Enable — check if auth is needed
    const needsAuth = connector.authType !== 'none' &&
      (connector.status === 'no_token' || connector.status === 'token_expired')

    if (needsAuth) {
      // Trigger OAuth popup
      setAuthenticatingIds((prev) => new Set([...prev, connectorId]))
      try {
        const result = await openOAuthPopup(connectorId)
        if (result.success) {
          // Update connector status locally
          setConnectors((prev) =>
            prev.map((c) =>
              c.id === connectorId ? { ...c, status: 'connected' as const } : c
            )
          )
          // Enable the connector after successful auth
          onConnectorsChange([...enabledConnectors, connectorId])
        }
      } catch {
        // OAuth popup closed or failed — don't enable
      } finally {
        setAuthenticatingIds((prev) => {
          const next = new Set(prev)
          next.delete(connectorId)
          return next
        })
      }
      return
    }

    // No auth needed — enable directly
    onConnectorsChange([...enabledConnectors, connectorId])
  }, [connectors, enabledConnectors, onConnectorsChange])

  const handleReconnect = useCallback(async (connectorId: string) => {
    setAuthenticatingIds((prev) => new Set([...prev, connectorId]))
    try {
      const result = await openOAuthPopup(connectorId)
      if (result.success) {
        setConnectors((prev) =>
          prev.map((c) =>
            c.id === connectorId ? { ...c, status: 'connected' as const } : c
          )
        )
      }
    } catch {
      // OAuth popup closed or failed
    } finally {
      setAuthenticatingIds((prev) => {
        const next = new Set(prev)
        next.delete(connectorId)
        return next
      })
    }
  }, [])

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
          disabled={disabled || isLoading || !hasConnectors}
          title={
            disabled
              ? 'Select a model first'
              : isLoading
                ? 'Loading connectors...'
                : !hasConnectors
                  ? 'No connectors available'
                  : 'Configure connections'
          }
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
          {!hasConnectors ? (
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
