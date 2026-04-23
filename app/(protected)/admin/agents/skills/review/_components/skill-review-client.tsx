"use client"

import { useState, useEffect, useCallback } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PageBranding } from "@/components/ui/page-branding"
import { IconRefresh, IconCheck, IconX } from "@tabler/icons-react"
import {
  getSkillReviewQueue,
  approveSkillToShared,
  rejectSkill,
  type SkillReviewItem,
} from "@/actions/admin/agent-skills.actions"

export function SkillReviewClient() {
  const { toast } = useToast()
  const [items, setItems] = useState<SkillReviewItem[]>([])
  const [loading, setLoading] = useState(true)

  const loadQueue = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getSkillReviewQueue()
      if (result.isSuccess && result.data) {
        setItems(result.data)
      } else {
        toast({
          title: "Error",
          description: result.message || "Failed to load review queue",
          variant: "destructive",
        })
      }
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    loadQueue()
  }, [loadQueue])

  const handleApprove = async (skillId: string) => {
    const result = await approveSkillToShared(skillId, 0) // adminUserId resolved server-side
    if (result.isSuccess) {
      toast({ title: "Skill approved to shared" })
      loadQueue()
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to approve",
        variant: "destructive",
      })
    }
  }

  const handleReject = async (skillId: string) => {
    const reason = window.prompt("Rejection reason:")
    if (!reason) return

    const result = await rejectSkill(skillId, 0, reason)
    if (result.isSuccess) {
      toast({ title: "Skill rejected" })
      loadQueue()
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to reject",
        variant: "destructive",
      })
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <PageBranding />
        <h1 className="text-2xl font-bold">Skill Review Queue</h1>
        <p className="text-muted-foreground text-sm">Review flagged and submitted skills</p>
      </div>

      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={loadQueue} disabled={loading}>
          <IconRefresh className="h-4 w-4 mr-1" />
          Refresh
        </Button>
        <span className="text-sm text-muted-foreground">
          {items.length} item{items.length !== 1 ? "s" : ""} pending review
        </span>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {loading ? "Loading..." : "No items pending review"}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <Card key={item.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-lg">{item.name}</CardTitle>
                    <CardDescription>{item.summary}</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={item.scanStatus === "flagged" ? "destructive" : "outline"}>
                      {item.scanStatus}
                    </Badge>
                    <Badge variant="secondary">{item.scope}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {item.scanFindings && (
                  <div className="mb-4 space-y-2">
                    <p className="text-sm font-medium">Scan Findings:</p>
                    {item.scanFindings.secrets && item.scanFindings.secrets.length > 0 && (
                      <div className="text-sm text-destructive">
                        <strong>Secrets:</strong> {item.scanFindings.secrets.join(", ")}
                      </div>
                    )}
                    {item.scanFindings.pii && item.scanFindings.pii.length > 0 && (
                      <div className="text-sm text-destructive">
                        <strong>PII:</strong> {item.scanFindings.pii.join(", ")}
                      </div>
                    )}
                    {item.scanFindings.npmAudit && item.scanFindings.npmAudit.length > 0 && (
                      <div className="text-sm text-destructive">
                        <strong>npm vulnerabilities:</strong>{" "}
                        {item.scanFindings.npmAudit.map((a) => `${a.severity}: ${a.title}`).join(", ")}
                      </div>
                    )}
                    {item.scanFindings.skillMdLint && item.scanFindings.skillMdLint.length > 0 && (
                      <div className="text-sm text-yellow-600">
                        <strong>SKILL.md issues:</strong> {item.scanFindings.skillMdLint.join(", ")}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
                  <span>Owner: {item.ownerUserId ?? "N/A"}</span>
                  <span>&middot;</span>
                  <span>Created: {new Date(item.createdAt).toLocaleString()}</span>
                </div>

                <div className="flex gap-2">
                  <Button size="sm" onClick={() => handleApprove(item.id)}>
                    <IconCheck className="h-4 w-4 mr-1" />
                    Approve to Shared
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleReject(item.id)}
                  >
                    <IconX className="h-4 w-4 mr-1" />
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
