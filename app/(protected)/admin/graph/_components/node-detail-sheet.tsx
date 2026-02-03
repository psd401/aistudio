"use client"

import { useEffect, useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  IconEdit,
  IconTrash,
  IconArrowRight,
  IconArrowLeft,
  IconLoader2,
} from "@tabler/icons-react"
import type { SelectGraphNode } from "@/lib/db/types"
import type { NodeConnection } from "@/lib/graph"

interface NodeDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  node: SelectGraphNode | null
  connections: NodeConnection[]
  loadingConnections: boolean
  onEdit: (node: SelectGraphNode) => void
  onDelete: (node: SelectGraphNode) => void
}

export function NodeDetailSheet({
  open,
  onOpenChange,
  node,
  connections,
  loadingConnections,
  onEdit,
  onDelete,
}: NodeDetailSheetProps) {
  const [activeSection, setActiveSection] = useState<"details" | "connections">(
    "details"
  )

  useEffect(() => {
    if (open) {
      setActiveSection("details")
    }
  }, [open])

  if (!node) return null

  const outgoing = connections.filter((c) => c.direction === "outgoing")
  const incoming = connections.filter((c) => c.direction === "incoming")

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="rounded-lg border bg-background shadow-lg p-0 flex flex-col data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "min(95vw, 720px)",
            maxWidth: "min(95vw, 720px)",
            maxHeight: "85vh",
            zIndex: 50,
          }}
        >
          {/* Close button */}
          <Dialog.Close className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <XIcon className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Dialog.Close>

          {/* Header */}
          <div className="flex-shrink-0 px-6 pt-6 pb-4">
            <div className="flex items-start justify-between pr-8">
              <div>
                <Dialog.Title className="text-xl font-semibold leading-none">
                  {node.name}
                </Dialog.Title>
                <Dialog.Description asChild>
                  <span className="inline-flex gap-2 mt-2">
                    <Badge variant="outline">{node.nodeType}</Badge>
                    <Badge variant="secondary">{node.nodeClass}</Badge>
                  </span>
                </Dialog.Description>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEdit(node)}
                  aria-label="Edit node"
                >
                  <IconEdit className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDelete(node)}
                  className="text-destructive hover:text-destructive"
                  aria-label="Delete node"
                >
                  <IconTrash className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Section tabs */}
            <div className="flex gap-2 mt-4">
              <Button
                variant={activeSection === "details" ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveSection("details")}
              >
                Details
              </Button>
              <Button
                variant={
                  activeSection === "connections" ? "default" : "outline"
                }
                size="sm"
                onClick={() => setActiveSection("connections")}
              >
                Connections ({connections.length})
              </Button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6">
            {activeSection === "details" && (
              <div className="space-y-4 pb-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Description
                  </p>
                  <p className="text-sm mt-1">
                    {node.description || (
                      <span className="italic text-muted-foreground">
                        No description
                      </span>
                    )}
                  </p>
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">
                      Type
                    </p>
                    <p className="text-sm mt-1">{node.nodeType}</p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">
                      Class
                    </p>
                    <p className="text-sm mt-1">{node.nodeClass}</p>
                  </div>
                </div>

                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Created
                  </p>
                  <p className="text-sm mt-1">
                    {node.createdAt
                      ? new Date(node.createdAt).toLocaleString()
                      : "—"}
                  </p>
                </div>

                {node.metadata &&
                  Object.keys(node.metadata).length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        Metadata
                      </p>
                      <pre className="text-xs mt-1 bg-muted p-3 rounded-md overflow-x-auto">
                        {JSON.stringify(node.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
              </div>
            )}

            {activeSection === "connections" && (
              <div className="space-y-4 pb-4">
                {loadingConnections ? (
                  <div className="flex items-center justify-center py-8">
                    <IconLoader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">
                      Loading connections...
                    </span>
                  </div>
                ) : connections.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-sm text-muted-foreground">
                      No connections found for this node.
                    </p>
                  </div>
                ) : (
                  <>
                    {outgoing.length > 0 && (
                      <div>
                        <h4 className="text-sm font-medium mb-2">
                          Outgoing ({outgoing.length})
                        </h4>
                        <div className="space-y-2">
                          {outgoing.map((conn) => (
                            <div
                              key={conn.edge.id}
                              className="flex items-center gap-2 p-2 rounded-md border bg-muted/30"
                            >
                              <IconArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                              <Badge variant="outline" className="shrink-0">
                                {conn.edge.edgeType}
                              </Badge>
                              <span className="text-sm font-medium truncate">
                                {conn.connectedNode.name}
                              </span>
                              <Badge
                                variant="secondary"
                                className="ml-auto shrink-0 text-xs"
                              >
                                {conn.connectedNode.nodeType}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {incoming.length > 0 && (
                      <div>
                        <h4 className="text-sm font-medium mb-2">
                          Incoming ({incoming.length})
                        </h4>
                        <div className="space-y-2">
                          {incoming.map((conn) => (
                            <div
                              key={conn.edge.id}
                              className="flex items-center gap-2 p-2 rounded-md border bg-muted/30"
                            >
                              <IconArrowLeft className="h-4 w-4 text-muted-foreground shrink-0" />
                              <span className="text-sm font-medium truncate">
                                {conn.connectedNode.name}
                              </span>
                              <Badge variant="outline" className="shrink-0">
                                {conn.edge.edgeType}
                              </Badge>
                              <Badge
                                variant="secondary"
                                className="ml-auto shrink-0 text-xs"
                              >
                                {conn.connectedNode.nodeType}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex-shrink-0 flex justify-end gap-2 px-6 py-4 border-t">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
