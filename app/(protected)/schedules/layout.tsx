import { redirect } from "next/navigation"
import { hasToolAccess } from "@/utils/roles"
import { getServerSession } from "@/lib/auth/server-session"
import { NavbarNested } from "@/components/navigation/navbar-nested"

// Force dynamic rendering for schedules pages to ensure proper authentication
export const dynamic = 'force-dynamic'

export default async function SchedulesLayout({
  children
}: {
  children: React.ReactNode
}) {
  // Get current session
  const session = await getServerSession()
  if (!session) {
    redirect("/sign-in")
  }

  // Check if user has access to the assistant-architect tool
  const hasAccess = await hasToolAccess("assistant-architect")
  if (!hasAccess) {
    redirect("/dashboard")
  }

  return (
    <div className="flex min-h-screen">
      <NavbarNested fullHeight />
      <main className="flex-1 lg:pl-[68px]">
        <div className="bg-white p-4 sm:p-6 md:p-8">
          {children}
        </div>
      </main>
    </div>
  )
}