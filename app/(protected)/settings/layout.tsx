import { ReactNode } from "react"
import { redirect } from "next/navigation"
import { getServerSession } from "@/lib/auth/server-session"
import { NavbarNested } from "@/components/navigation/navbar-nested"

export default async function SettingsLayout({
  children
}: {
  children: ReactNode
}) {
  const session = await getServerSession()
  if (!session) {
    redirect("/sign-in")
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
