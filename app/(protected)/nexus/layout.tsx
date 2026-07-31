import { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getServerSession } from '@/lib/auth/server-session'
import { NavbarNested } from '@/components/navigation/navbar-nested'
import { fontMeridian } from '@/lib/atrium/meridian-fonts'
import '@/styles/atrium-meridian.css'
import '@/styles/app-meridian.css'

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
    /*
     * Meridian scope. The classes go on the EXISTING root div rather than a new
     * wrapper: Nexus conversation state is remount-sensitive (see
     * docs/features/nexus-conversation-architecture.md — stableConversationId,
     * ConversationInitializer), so the component tree is left structurally
     * untouched. Adding classes to an existing element changes no identity and
     * triggers no remount.
     *
     * Most of the conversion is free — atrium-meridian.css remaps the
     * Tailwind-v4 --color-* theme tokens, so every shadcn primitive inside this
     * scope re-renders in Meridian without touching its markup.
     */
    <div className={`app-meridian ${fontMeridian.variable} flex h-screen overflow-hidden`}>
      <NavbarNested fullHeight />
      <main className="flex-1 lg:pl-[68px] overflow-hidden">
        <div className="bg-white h-full">
          {children}
        </div>
      </main>
    </div>
  )
}
