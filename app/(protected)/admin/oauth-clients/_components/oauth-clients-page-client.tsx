/**
 * OAuth Clients Admin - Client Component
 * Manages state for data table + create/revoke operations.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

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
import { ClientFormSheet } from "./client-form-sheet"
import type { OAuthClientRow } from "@/actions/oauth/oauth-client.actions"
import { revokeOAuthClient, listOAuthClients } from "@/actions/oauth/oauth-client.actions"
import { Plus, Ban } from "lucide-react"

// ============================================
// Component
// ============================================

interface Props {
  initialClients: OAuthClientRow[]
}

export function OAuthClientsPageClient({ initialClients }: Props) {
  const [clients, setClients] = useState(initialClients)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await listOAuthClients()
    if (result.isSuccess && result.data) {
      setClients(result.data)
      setError(null)
    } else {
      setError(result.message || "Failed to load OAuth clients")
    }
  }, [])

  const handleRevoke = useCallback(
    async (clientId: string) => {
      const result = await revokeOAuthClient(clientId)
      if (!result.isSuccess) {
        setError(result.message || "Failed to revoke client")
        return
      }
      await refresh()
    },
    [refresh]
  )

  return (
    <div>
      <div className="flex justify-end mb-4">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Register Client
            </Button>
          </SheetTrigger>
          <SheetContent className="sm:max-w-lg">
            <SheetHeader>
              <SheetTitle>Register OAuth Client</SheetTitle>
              <SheetDescription>
                Create a new OAuth2 client application for external service
                authentication.
              </SheetDescription>
            </SheetHeader>
            <ClientFormSheet
              onSuccess={() => {
                setSheetOpen(false)
                void refresh()
              }}
            />
          </SheetContent>
        </Sheet>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {clients.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No OAuth clients registered yet.
        </div>
      ) : (
        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Client ID</TableHead>
                <TableHead>Auth Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((client) => (
                <TableRow key={client.id}>
                  <TableCell className="font-medium">
                    {client.clientName}
                  </TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      {client.clientId.slice(0, 8)}...
                    </code>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {client.tokenEndpointAuthMethod === "none"
                        ? "Public (PKCE)"
                        : "Confidential"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={client.isActive ? "default" : "destructive"}
                    >
                      {client.isActive ? "Active" : "Revoked"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {client.allowedScopes.length} scope(s)
                    </span>
                  </TableCell>
                  <TableCell>
                    {client.isActive && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <Ban className="h-4 w-4 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              Revoke Client
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              This will deactivate the OAuth client &quot;
                              {client.clientName}&quot;. Existing tokens will no
                              longer be valid.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleRevoke(client.clientId)}
                            >
                              Revoke
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
