"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  createMcpServer,
  updateMcpServer,
  type McpServerWithStats,
} from "@/actions/admin/connector.actions"

interface Props {
  server: McpServerWithStats | null
  onSuccess: () => void
}

export function ConnectorFormSheet({ server, onSuccess }: Props) {
  const isEditing = !!server

  const [name, setName] = useState(server?.name ?? "")
  const [url, setUrl] = useState(server?.url ?? "")
  const [transport, setTransport] = useState(server?.transport ?? "http")
  const [authType, setAuthType] = useState(server?.authType ?? "none")
  const [credentialsKey, setCredentialsKey] = useState(
    server?.credentialsKey ?? ""
  )
  const [maxConnections, setMaxConnections] = useState(
    String(server?.maxConnections ?? 10)
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setIsSubmitting(true)
    setError(null)

    try {
      const maxConn = parseInt(maxConnections, 10)

      if (isEditing && server) {
        const result = await updateMcpServer({
          id: server.id,
          name,
          url,
          transport,
          authType,
          credentialsKey: credentialsKey || null,
          maxConnections: isNaN(maxConn) ? 10 : maxConn,
        })
        if (!result.isSuccess) {
          setError(result.message || "Failed to update connector")
          return
        }
      } else {
        const result = await createMcpServer({
          name,
          url,
          transport,
          authType,
          credentialsKey: credentialsKey || undefined,
          maxConnections: isNaN(maxConn) ? 10 : maxConn,
        })
        if (!result.isSuccess) {
          setError(result.message || "Failed to create connector")
          return
        }
      }

      onSuccess()
    } catch {
      setError("An unexpected error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-4">
      <div>
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Canva"
          required
        />
      </div>

      <div>
        <Label htmlFor="url">URL</Label>
        <Input
          id="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.canva.com/mcp"
          required
        />
      </div>

      <div>
        <Label>Transport</Label>
        <Select value={transport} onValueChange={setTransport}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="http">HTTP</SelectItem>
            <SelectItem value="stdio">Stdio</SelectItem>
            <SelectItem value="websocket">WebSocket</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>Auth Type</Label>
        <Select value={authType} onValueChange={setAuthType}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="oauth">OAuth</SelectItem>
            <SelectItem value="api_key">API Key</SelectItem>
            <SelectItem value="jwt">JWT</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {authType !== "none" && (
        <div>
          <Label htmlFor="credentialsKey">Credentials Key</Label>
          <Input
            id="credentialsKey"
            value={credentialsKey}
            onChange={(e) => setCredentialsKey(e.target.value)}
            placeholder="AWS Secrets Manager key"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Reference to credentials stored in AWS Secrets Manager
          </p>
        </div>
      )}

      <div>
        <Label htmlFor="maxConnections">Max Connections</Label>
        <Input
          id="maxConnections"
          type="number"
          min="1"
          value={maxConnections}
          onChange={(e) => setMaxConnections(e.target.value)}
        />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <Button
        type="submit"
        disabled={isSubmitting || !name || !url}
        className="w-full"
      >
        {isSubmitting
          ? isEditing
            ? "Updating..."
            : "Creating..."
          : isEditing
            ? "Update Connector"
            : "Create Connector"}
      </Button>
    </form>
  )
}
