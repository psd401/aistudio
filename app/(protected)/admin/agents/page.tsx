import { requireRole } from "@/lib/auth/role-helpers"
import { AgentDashboardClient } from "./_components/agent-dashboard-client"

export default async function AdminAgentsPage() {
  await requireRole("administrator")

  return <AgentDashboardClient />
}
