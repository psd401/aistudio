import { NavbarNested } from "@/components/navigation/navbar-nested"

interface StandardPageLayoutProps {
  children: React.ReactNode
}

export default function StandardPageLayout({
  children
}: StandardPageLayoutProps) {
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