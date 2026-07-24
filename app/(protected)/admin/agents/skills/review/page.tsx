import { adminPageMetadata } from "../../../_lib/admin-pages"
import { requireRole } from "@/lib/auth/role-helpers"
import { SkillReviewClient } from "./_components/skill-review-client"

export const metadata = adminPageMetadata("/admin/agents/skills/review")

export default async function AdminAgentSkillsReviewPage() {
  await requireRole("administrator")

  return <SkillReviewClient />
}
