import { adminPageMetadata } from "../_lib/admin-pages"
import { requireRole } from "@/lib/auth/role-helpers"
import { AgentDashboardClient } from "./_components/agent-dashboard-client"

export const metadata = adminPageMetadata("/admin/agents")

export default async function AdminAgentsPage() {
  await requireRole("administrator")

  return <AgentDashboardClient />
}
