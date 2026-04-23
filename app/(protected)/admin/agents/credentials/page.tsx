import { requireRole } from "@/lib/auth/role-helpers"
import { CredentialsClient } from "./_components/credentials-client"

export default async function AdminAgentCredentialsPage() {
  await requireRole("administrator")

  return <CredentialsClient />
}
