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
  const [transport, setTransport] = useState<"http" | "stdio" | "websocket">(
    (server?.transport as "http" | "stdio" | "websocket") ?? "http"
  )
  const [authType, setAuthType] = useState<"none" | "oauth" | "api_key" | "jwt">(
    (server?.authType as "none" | "oauth" | "api_key" | "jwt") ?? "none"
  )
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
    setError(null)

    // Validate credentialsKey required for api_key and jwt auth types
    // OAuth uses MCP-native dynamic client registration — no admin credentials needed
    if ((authType === "api_key" || authType === "jwt") && !credentialsKey.trim()) {
      setError("Credentials Key is required for API Key and JWT auth types.")
      return
    }

    // Validate maxConnections range
    const maxConn = parseInt(maxConnections, 10)
    if (!Number.isInteger(maxConn) || maxConn < 1 || maxConn > 100) {
      setError("Max Connections must be between 1 and 100.")
      return
    }

    setIsSubmitting(true)

    try {
      const commonPayload = {
        name,
        url,
        transport,
        authType,
        maxConnections: maxConn,
      }

      const result =
        isEditing && server
          ? await updateMcpServer({
              id: server.id,
              ...commonPayload,
              credentialsKey: credentialsKey || null,
            })
          : await createMcpServer({
              ...commonPayload,
              credentialsKey: credentialsKey || undefined,
            })

      if (!result.isSuccess) {
        setError(
          result.message ??
            (isEditing ? "Failed to update connector" : "Failed to create connector")
        )
        return
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
          maxLength={255}
          required
        />
      </div>

      <div>
        <Label htmlFor="url">URL</Label>
        <Input
          id="url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.canva.com/mcp"
          required
        />
      </div>

      <div>
        <Label>Transport</Label>
        <Select
          value={transport}
          onValueChange={(v) => setTransport(v as "http" | "stdio" | "websocket")}
        >
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
        <Select
          value={authType}
          onValueChange={(v) => {
            setAuthType(v as "none" | "oauth" | "api_key" | "jwt")
            if (v === "none") setError(null)
          }}
        >
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

      {authType === "oauth" && (
        <div className="rounded-md border border-border bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">
            Users will authenticate directly with the service when connecting.
            No admin credentials are needed — the MCP protocol handles client registration automatically.
          </p>
        </div>
      )}

      {(authType === "api_key" || authType === "jwt") && (
        <div>
          <Label htmlFor="credentialsKey">
            Credentials Key <span className="text-destructive">*</span>
          </Label>
          <Input
            id="credentialsKey"
            value={credentialsKey}
            onChange={(e) => setCredentialsKey(e.target.value)}
            placeholder="AWS Secrets Manager key"
            maxLength={255}
            required
          />
          <p className="text-xs text-muted-foreground mt-1">
            Reference to credentials stored in AWS Secrets Manager
          </p>
        </div>
      )}

      <div>
        <Label htmlFor="maxConnections">Max Connections (1–100)</Label>
        <Input
          id="maxConnections"
          type="number"
          min="1"
          max="100"
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
