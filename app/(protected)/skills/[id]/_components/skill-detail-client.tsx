"use client"

import { useMemo } from "react"
import Link from "next/link"
import { ArrowLeft, Download, MessageSquarePlus } from "lucide-react"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/ui/markdown"
import type { CatalogSkillDetail } from "@/actions/db/skills-catalog.actions"

interface SkillDetailClientProps {
  skill: CatalogSkillDetail
}

/**
 * Build the "Use in chat" URL. Binds the Nexus session to the skill (skillId) so
 * the server enforces its allowed-tools pin, and pre-enables the pinned tools via
 * the existing `?tool=` param. A skill with no pin binds skillId only (the user
 * keeps their default tool selection; server enforcement is a no-op).
 */
function buildUseInChatHref(skill: CatalogSkillDetail): string {
  const params = new URLSearchParams()
  params.set("skillId", skill.id)
  for (const tool of skill.allowedTools) {
    params.append("tool", tool)
  }
  return `/nexus?${params.toString()}`
}

export function SkillDetailClient({ skill }: SkillDetailClientProps) {
  const useInChatHref = useMemo(() => buildUseInChatHref(skill), [skill])
  const exportHref = `/api/skills/${skill.id}/export`

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label="Back to skills">
          <Link href="/skills">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold text-gray-900">{skill.name}</h1>
        <Badge variant="secondary">v{skill.version}</Badge>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button asChild data-testid="use-in-chat">
          <Link href={useInChatHref}>
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            Use in chat
          </Link>
        </Button>
        <Button asChild variant="outline" data-testid="export-zip">
          {/* Plain anchor so the browser downloads the zip rather than client-routing. */}
          <a href={exportHref} download>
            <Download className="mr-2 h-4 w-4" />
            Export as zip
          </a>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
          <CardDescription>{skill.summary}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="text-sm font-medium mb-2">Pinned tools</h3>
            {skill.allowedTools.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No tools pinned — this skill may use any tool the caller already
                has access to.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {skill.allowedTools.map((tool) => (
                  <Badge key={tool} variant="outline">
                    {tool}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">SKILL.md</CardTitle>
          <CardDescription>
            The canonical skill definition scanned by the platform.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {skill.skillMd ? (
            <Markdown content={skill.skillMd} />
          ) : (
            <p className="text-sm text-muted-foreground">
              The SKILL.md artifact is not available for preview.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
