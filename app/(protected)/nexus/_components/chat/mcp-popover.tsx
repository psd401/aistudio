'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Plug } from 'lucide-react'
import { listAvailableMcpServers, type AvailableMcpServer } from '@/actions/nexus/mcp-servers.actions'

const TRANSPORT_LABELS: Record<string, string> = {
  http: 'HTTP',
  stdio: 'Stdio',
  websocket: 'WebSocket',
}

export function MCPPopover() {
  const [servers, setServers] = useState<AvailableMcpServer[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    listAvailableMcpServers().then((result) => {
      if (result.isSuccess && result.data) {
        setServers(result.data)
      }
      setIsLoading(false)
    })
  }, [])

  const disabled = isLoading || servers.length === 0

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={disabled}
          title={
            isLoading
              ? 'Loading connections…'
              : servers.length === 0
                ? 'No MCP connectors available'
                : 'MCP Connections'
          }
          aria-label="MCP Connections"
        >
          <Plug className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Connect</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="mb-2">
          <h4 className="text-sm font-medium">MCP Connections</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            Available MCP servers
          </p>
        </div>
        <ul className="space-y-1.5">
          {servers.map((server) => (
            <li
              key={server.id}
              className="flex items-center justify-between rounded-md border px-2 py-1.5 text-sm"
            >
              <span className="font-medium truncate mr-2">{server.name}</span>
              <Badge variant="outline" className="shrink-0 text-xs">
                {TRANSPORT_LABELS[server.transport] ?? server.transport}
              </Badge>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
