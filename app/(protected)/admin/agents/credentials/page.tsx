import { requireRole } from "@/lib/auth/role-helpers"
import { CredentialsClient } from "./_components/credentials-client"

export default async function AdminAgentCredentialsPage() {
  await requireRole("administrator")

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Agent Credentials</h1>
        <p className="text-muted-foreground">
          Manage shared secrets, fulfill credential requests, and review the audit log.
        </p>
      </div>
      <CredentialsClient />
    </div>
  )
}
