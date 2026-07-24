import { redirect } from 'next/navigation'
import { getServerSession } from '@/lib/auth/server-session'
import { hasRole } from '@/utils/roles'
import { ModerationDashboard } from './_components/moderation-dashboard'
import { PageBranding } from "@/components/ui/page-branding"
import { adminPageMetadata } from "../_lib/admin-pages"

export const metadata = adminPageMetadata("/admin/prompts")

export default async function AdminPromptsPage() {
  const session = await getServerSession()

  if (!session) {
    redirect('/auth/signin')
  }

  const isAdmin = await hasRole('administrator')
  if (!isAdmin) {
    redirect('/')
  }

  return (
    <div className="container mx-auto py-8">
      <div className="mb-6">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-gray-900">Prompt Library Moderation</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review and moderate public prompt submissions
        </p>
      </div>

      <ModerationDashboard />
    </div>
  )
}
