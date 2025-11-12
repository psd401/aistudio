import { redirect, notFound } from "next/navigation"
import { getServerSession } from "@/lib/auth/server-session"
import { getRepository } from "@/actions/repositories/repository.actions"
import { RepositoryForm } from "@/components/features/repositories/repository-form"

interface EditRepositoryPageProps {
  params: Promise<{
    id: string
  }>
}

export default async function EditRepositoryPage({ params }: EditRepositoryPageProps) {
  const session = await getServerSession()
  if (!session) {
    redirect("/sign-in")
  }

  const { id } = await params
  const repositoryId = Number.parseInt(id)
  if (isNaN(repositoryId)) {
    notFound()
  }

  const result = await getRepository(repositoryId)
  if (!result.isSuccess || !result.data) {
    notFound()
  }

  return (
    <div className="container mx-auto py-6 max-w-2xl">
      <RepositoryForm repository={result.data} />
    </div>
  )
}