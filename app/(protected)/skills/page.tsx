import { redirect } from "next/navigation"
import { getServerSession } from "@/lib/auth/server-session"
import { getApprovedSkillsAction } from "@/actions/db/skills-catalog.actions"
import { PageBranding } from "@/components/ui/page-branding"
import { Separator } from "@/components/ui/separator"
import { SkillsCatalogClient } from "./_components/skills-catalog-client"

export const metadata = {
  title: "Skills",
  description: "Browse approved skills and use them in a Nexus chat",
}

/**
 * User-facing skill catalog (Issue #925, AC#4). Lists approved (shared + clean)
 * skills for any authenticated user. Each card links to a detail page with a
 * rendered SKILL.md preview, a "Use in chat" action, and a zip export.
 */
export default async function SkillsCatalogPage() {
  const session = await getServerSession()
  if (!session || !session.sub) {
    redirect("/sign-in")
  }

  const result = await getApprovedSkillsAction()
  const skills = result.isSuccess ? result.data : []

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <PageBranding />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Skills</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Browse approved skills and load one into a Nexus chat
          </p>
        </div>
      </div>

      <Separator />

      <SkillsCatalogClient initialSkills={skills} />
    </div>
  )
}
