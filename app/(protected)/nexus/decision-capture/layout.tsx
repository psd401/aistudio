import { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { hasToolAccess } from '@/utils/roles'

/**
 * Decision Capture Layout
 *
 * Role-gated layout requiring the "decision-capture" tool permission.
 * The parent nexus layout already handles session auth and NavbarNested.
 *
 * Part of Epic #675 (Context Graph Decision Capture Layer) - Issue #681
 */
export default async function DecisionCaptureLayout({ children }: { children: ReactNode }) {
  const hasAccess = await hasToolAccess('decision-capture')
  if (!hasAccess) {
    redirect('/dashboard')
  }

  return <>{children}</>
}
