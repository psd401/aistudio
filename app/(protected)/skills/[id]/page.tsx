import { redirect, notFound } from "next/navigation"
import { getServerSession } from "@/lib/auth/server-session"
import { getApprovedSkillDetailAction } from "@/actions/db/skills-catalog.actions"
import { SkillDetailClient } from "./_components/skill-detail-client"

/**
 * Skill detail page (Issue #925, AC#4). Shows the rendered SKILL.md preview,
 * version, the skill's pinned tools, a "Use in chat" action that loads the skill
 * into a Nexus session, and a zip export for Claude Code / Desktop.
 */
export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await getServerSession()
  if (!session || !session.sub) {
    redirect("/sign-in")
  }

  const { id } = await params
  const result = await getApprovedSkillDetailAction(id)
  if (!result.isSuccess || !result.data) {
    notFound()
  }

  return <SkillDetailClient skill={result.data} />
}
