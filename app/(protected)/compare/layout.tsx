import { redirect } from "next/navigation"
import { hasToolAccess } from "@/utils/roles"
import { getServerSession } from "@/lib/auth/server-session"
import { NavbarNested } from "@/components/navigation/navbar-nested"

export default async function CompareLayout({
  children
}: {
  children: React.ReactNode
}) {
  // Get current session
  const session = await getServerSession()
  if (!session) {
    redirect("/sign-in")
  }

  // Check if user has access to the model-compare tool
  const hasAccess = await hasToolAccess("model-compare")
  if (!hasAccess) {
    redirect("/dashboard")
  }

  return (
    <div className="flex min-h-screen">
      <NavbarNested fullHeight />
      <main className="flex-1 lg:pl-[68px]">
        <div className="bg-white p-4 sm:p-6 md:p-8">
          <div className="flex flex-col">
            {/* Main Content */}
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-white">
              {children}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}