import { requireRole } from "@/lib/auth/role-helpers"
import { SkillsListClient } from "./_components/skills-list-client"

export default async function AdminAgentSkillsPage() {
  await requireRole("administrator")

  return <SkillsListClient />
}
