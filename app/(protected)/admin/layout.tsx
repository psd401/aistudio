import { NavbarNested } from "@/components/navigation/navbar-nested"

// Force dynamic rendering for all admin pages to avoid static generation issues with authentication
export const dynamic = 'force-dynamic'

export default async function AdminLayout({
  children
}: {
  children: React.ReactNode
}) {
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