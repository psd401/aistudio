"use client"

import { useRouter } from "next/navigation"
import { Inbox } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface TriageQuickJumpProps {
  users: { email: string; enabled: boolean }[]
}

/**
 * Quick-jump dropdown for email triage: lists every user with triage state and
 * navigates straight to their /admin/agents/[userEmail]/triage detail page.
 * Rendered on the /admin hub next to the Agent Platform section.
 */
export function TriageQuickJump({ users }: TriageQuickJumpProps) {
  const router = useRouter()

  if (users.length === 0) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="triage-quick-jump-empty"
      >
        No users have opted in to email triage yet.
      </p>
    )
  }

  return (
    <div className="flex items-center gap-2" data-testid="triage-quick-jump">
      <Inbox className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <Select
        onValueChange={email =>
          router.push(`/admin/agents/${encodeURIComponent(email)}/triage`)
        }
      >
        <SelectTrigger
          className="w-[280px]"
          data-testid="triage-quick-jump-select"
          aria-label="Jump to a user's email triage page"
        >
          <SelectValue placeholder="Jump to a user's triage page…" />
        </SelectTrigger>
        <SelectContent>
          {users.map(user => (
            <SelectItem key={user.email} value={user.email}>
              {user.email}
              {!user.enabled && " (paused)"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
