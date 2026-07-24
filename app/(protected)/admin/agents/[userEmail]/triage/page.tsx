/**
 * Admin sub-page — per-user email triage state.
 *
 * Read-only view for support cases. Shows enabled state, rule counts,
 * recent decisions, Gmail label IDs, and three action buttons (pause,
 * reset learned patterns, force re-onboarding). Per the email-triage
 * Phase 1 plan, this is the ONLY web UI for the feature; the user-
 * facing flow is entirely through chat.
 *
 * Route: /admin/agents/[userEmail]/triage
 */

import { requireRole } from "@/lib/auth/role-helpers"
import { TriageDetailClient } from "./_components/triage-detail-client"

export const metadata = { title: "Email Triage | Admin" }

interface PageProps {
  params: Promise<{ userEmail: string }>
}

export default async function AdminAgentsTriagePage({ params }: PageProps) {
  await requireRole("administrator")
  const { userEmail } = await params
  const decoded = decodeURIComponent(userEmail).toLowerCase()
  return <TriageDetailClient userEmail={decoded} />
}
