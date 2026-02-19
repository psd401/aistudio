'use client'

import { createContext, useContext, useCallback, useState, useMemo } from 'react'

/**
 * Metadata about an MCP connector server
 */
export interface ConnectorServerInfo {
  serverId: string
  serverName: string
  /** Optional icon URL or component key for the connector */
  iconUrl?: string
}

/**
 * Maps tool names to the connector server they belong to.
 * Populated when connector tools are fetched (MCPPopover / chat stream).
 */
export interface ConnectorToolMap {
  [toolName: string]: ConnectorServerInfo
}

interface ConnectorToolContextValue {
  /** Map of tool names to connector server info */
  toolMap: ConnectorToolMap
  /** Register tools from a connector server */
  registerConnectorTools: (serverInfo: ConnectorServerInfo, toolNames: string[]) => void
  /** Unregister all tools from a connector server */
  unregisterConnectorServer: (serverId: string) => void
  /** Check if a tool name belongs to a connector */
  isConnectorTool: (toolName: string) => boolean
  /** Get connector info for a tool name (returns undefined for non-connector tools) */
  getConnectorInfo: (toolName: string) => ConnectorServerInfo | undefined
  /** List of server IDs that failed reconnect (from X-Connector-Reconnect header) */
  failedServerIds: string[]
  /** Set failed server IDs from reconnect header */
  setFailedServerIds: (ids: string[]) => void
  /** Clear failed server IDs (e.g., after successful reconnect) */
  clearFailedServerIds: () => void
}

const ConnectorToolContext = createContext<ConnectorToolContextValue | null>(null)

export function ConnectorToolProvider({ children }: { children: React.ReactNode }) {
  const [toolMap, setToolMap] = useState<ConnectorToolMap>({})
  const [failedServerIds, setFailedServerIds] = useState<string[]>([])

  const registerConnectorTools = useCallback((serverInfo: ConnectorServerInfo, toolNames: string[]) => {
    setToolMap(prev => {
      const next = { ...prev }
      for (const name of toolNames) {
        next[name] = serverInfo
      }
      return next
    })
  }, [])

  const unregisterConnectorServer = useCallback((serverId: string) => {
    setToolMap(prev => {
      const next: ConnectorToolMap = {}
      for (const [name, info] of Object.entries(prev)) {
        if (info.serverId !== serverId) {
          next[name] = info
        }
      }
      return next
    })
  }, [])

  const isConnectorTool = useCallback((toolName: string) => {
    return toolName in toolMap
  }, [toolMap])

  const getConnectorInfo = useCallback((toolName: string) => {
    return toolMap[toolName]
  }, [toolMap])

  const clearFailedServerIds = useCallback(() => {
    setFailedServerIds([])
  }, [])

  const value = useMemo<ConnectorToolContextValue>(() => ({
    toolMap,
    registerConnectorTools,
    unregisterConnectorServer,
    isConnectorTool,
    getConnectorInfo,
    failedServerIds,
    setFailedServerIds,
    clearFailedServerIds,
  }), [
    toolMap,
    registerConnectorTools,
    unregisterConnectorServer,
    isConnectorTool,
    getConnectorInfo,
    failedServerIds,
    clearFailedServerIds,
  ])

  return (
    <ConnectorToolContext.Provider value={value}>
      {children}
    </ConnectorToolContext.Provider>
  )
}

/**
 * Hook to access connector tool context.
 * Returns null if used outside of ConnectorToolProvider (graceful degradation).
 */
export function useConnectorTools(): ConnectorToolContextValue | null {
  return useContext(ConnectorToolContext)
}
