"use client"

import { useEffect, useState, useCallback } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/use-toast"
import { format } from "date-fns"
import type {
  NexusActivityItem,
  NexusMessageItem,
} from "@/actions/admin/activity-management.actions"
import { getConversationMessages } from "@/actions/admin/activity-management.actions"
import { cn } from "@/lib/utils"

interface NexusDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversation: NexusActivityItem | null
}

export function NexusDetailSheet({
  open,
  onOpenChange,
  conversation,
}: NexusDetailSheetProps) {
  const { toast } = useToast()
  const [messages, setMessages] = useState<NexusMessageItem[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)

  const loadMessages = useCallback(async () => {
    if (!conversation?.id) return

    setLoadingMessages(true)
    const result = await getConversationMessages(conversation.id)

    if (result.isSuccess && result.data) {
      setMessages(result.data)
    } else {
      toast({
        variant: "destructive",
        title: "Error loading messages",
        description: result.message,
      })
    }
    setLoadingMessages(false)
  }, [conversation?.id, toast])

  useEffect(() => {
    if (open && conversation?.id) {
      loadMessages()
    } else {
      setMessages([])
    }
  }, [open, conversation?.id, loadMessages])

  if (!conversation) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-hidden flex flex-col">
        <SheetHeader>
          <SheetTitle className="truncate">
            {conversation.title || "Untitled Conversation"}
          </SheetTitle>
          <SheetDescription>Conversation ID: {conversation.id}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-hidden flex flex-col mt-6">
          {/* Overview Section */}
          <div className="space-y-3 pb-4">
            <h3 className="text-sm font-medium">Overview</h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">User</span>
                <p className="font-medium">{conversation.userName}</p>
                <p className="text-xs text-muted-foreground">
                  {conversation.userEmail}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Provider</span>
                <p>
                  <Badge variant="secondary">{conversation.provider}</Badge>
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Model</span>
                <p className="font-medium">{conversation.modelUsed || "—"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Messages</span>
                <p className="font-medium">
                  {conversation.messageCount?.toLocaleString() ?? 0}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Total Tokens</span>
                <p className="font-medium">
                  {conversation.totalTokens?.toLocaleString() ?? 0}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Created</span>
                <p className="font-medium">
                  {conversation.createdAt
                    ? format(new Date(conversation.createdAt), "PPp")
                    : "—"}
                </p>
              </div>
            </div>
          </div>

          <Separator />

          {/* Messages Section */}
          <div className="flex-1 overflow-hidden mt-4">
            <h3 className="text-sm font-medium mb-3">Messages</h3>
            {loadingMessages ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 w-full" />
                ))}
              </div>
            ) : messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No messages found</p>
            ) : (
              <ScrollArea className="h-[calc(100vh-400px)]">
                <div className="space-y-4 pr-4">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={cn(
                        "rounded-lg p-3 text-sm",
                        message.role === "user"
                          ? "bg-muted"
                          : message.role === "assistant"
                            ? "bg-primary/10 border border-primary/20"
                            : "bg-yellow-50 dark:bg-yellow-900/20"
                      )}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <Badge
                          variant={
                            message.role === "user" ? "secondary" : "default"
                          }
                        >
                          {message.role}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {message.createdAt
                            ? format(new Date(message.createdAt), "p")
                            : ""}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap break-words">
                        {message.content || "(empty)"}
                      </p>
                      {message.tokenUsage && (
                        <p className="text-xs text-muted-foreground mt-2">
                          Tokens: {message.tokenUsage.totalTokens?.toLocaleString() ?? 0}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
