import { redirect } from "next/navigation"
import { getServerSession } from "@/lib/auth/server-session"
import { RepositoryList } from "@/components/features/repositories/repository-list"

export default async function RepositoriesPage() {
  const session = await getServerSession()
  if (!session) {
    redirect("/sign-in")
  }

  return <RepositoryList />
}