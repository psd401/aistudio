"use client"

import { useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
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
import { ConnectorFormSheet } from "./connector-form-sheet"
import {
  listMcpServers,
  deleteMcpServer,
  type McpServerWithStats,
} from "@/actions/admin/connector.actions"
import { Plus, Trash2, Pencil } from "lucide-react"

interface Props {
  initialServers: McpServerWithStats[]
  fetchError: string | null
}

export function ConnectorsPageClient({ initialServers, fetchError: initialFetchError }: Props) {
  const [servers, setServers] = useState(initialServers)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<McpServerWithStats | null>(
    null
  )
  const [error, setError] = useState<string | null>(initialFetchError)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await listMcpServers()
    if (result.isSuccess && result.data) {
      setServers(result.data)
      setError(null)
    } else {
      setError(result.message || "Failed to load connectors")
    }
  }, [])

  const handleDelete = useCallback(
    async (id: string) => {
      setDeletingId(id)
      const result = await deleteMcpServer(id)
      setDeletingId(null)
      if (!result.isSuccess) {
        setError(result.message || "Failed to delete connector")
        return
      }
      await refresh()
    },
    [refresh]
  )

  const handleEdit = useCallback((server: McpServerWithStats) => {
    setEditingServer(server)
    setSheetOpen(true)
  }, [])

  const handleAdd = useCallback(() => {
    setEditingServer(null)
    setSheetOpen(true)
  }, [])

  const handleFormSuccess = useCallback(() => {
    setSheetOpen(false)
    setEditingServer(null)
    void refresh()
  }, [refresh])

  const transportLabel = (transport: string) => {
    switch (transport) {
      case "http":
        return "HTTP"
      case "stdio":
        return "Stdio"
      case "websocket":
        return "WebSocket"
      default:
        return transport
    }
  }

  const authLabel = (authType: string) => {
    switch (authType) {
      case "oauth":
        return "OAuth"
      case "api_key":
        return "API Key"
      case "jwt":
        return "JWT"
      case "cognito_passthrough":
        return "Cognito Passthrough"
      case "none":
        return "None"
      default:
        return authType
    }
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button onClick={handleAdd}>
              <Plus className="mr-2 h-4 w-4" />
              Add Connector
            </Button>
          </SheetTrigger>
          <SheetContent className="sm:max-w-lg">
            <SheetHeader>
              <SheetTitle>
                {editingServer ? "Edit Connector" : "Add Connector"}
              </SheetTitle>
              <SheetDescription>
                {editingServer
                  ? "Update MCP server configuration."
                  : "Register a new MCP server as a Nexus connector."}
              </SheetDescription>
            </SheetHeader>
            {/* key forces remount when switching between servers, resetting form state */}
            <ConnectorFormSheet
              key={editingServer?.id ?? "new"}
              server={editingServer}
              onSuccess={handleFormSuccess}
            />
          </SheetContent>
        </Sheet>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Show table when servers exist, empty state when no servers and no error.
         When error + no servers, only the error banner above is shown. */}
      {servers.length > 0 ? (
        <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead>Auth</TableHead>
                  <TableHead>Connections</TableHead>
                  <TableHead>Max</TableHead>
                  <TableHead className="w-24">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servers.map((server) => (
                  <TableRow key={server.id}>
                    <TableCell className="font-medium">{server.name}</TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-1 py-0.5 rounded max-w-[200px] truncate block">
                        {server.url}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {transportLabel(server.transport)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {authLabel(server.authType)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">
                        {server.connectionCount}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {server.maxConnections ?? 10}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(server)}
                          aria-label={`Edit ${server.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Delete ${server.name}`}
                              disabled={deletingId === server.id}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Delete Connector
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                This will permanently delete the MCP server &quot;
                                {server.name}&quot; and all its connections.
                                This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDelete(server.id)}
                                disabled={deletingId === server.id}
                              >
                                {deletingId === server.id ? "Deleting…" : "Delete"}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
      ) : !error ? (
        <div className="text-center py-12 text-muted-foreground">
          No MCP connectors registered yet.
        </div>
      ) : null}
    </div>
  )
}
