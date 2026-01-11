import { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getServerSession } from '@/lib/auth/server-session'
import { NavbarNested } from '@/components/navigation/navbar-nested'

interface NexusLayoutProps {
  children: ReactNode
}

export default async function NexusLayout({ children }: NexusLayoutProps) {
  // Get current session
  const session = await getServerSession()
  if (!session) {
    redirect('/sign-in')
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <NavbarNested fullHeight />
      <main className="flex-1 lg:pl-[68px] overflow-hidden">
        <div className="bg-white h-full">
          {children}
        </div>
      </main>
    </div>
  )
}
