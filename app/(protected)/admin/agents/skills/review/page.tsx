import { requireRole } from "@/lib/auth/role-helpers"
import { SkillReviewClient } from "./_components/skill-review-client"

export default async function AdminAgentSkillsReviewPage() {
  await requireRole("administrator")

  return <SkillReviewClient />
}
