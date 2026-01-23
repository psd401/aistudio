import { redirect } from "next/navigation"
import { CreateForm } from "./_components/create-form"
import { CreateLayout } from "./_components/create-layout"
import { getServerSession } from "@/lib/auth/server-session"

// This page uses authentication which requires headers
export const dynamic = 'force-dynamic'

export default async function CreateAssistantPage() {
  // Check authentication
  const session = await getServerSession()
  if (!session || !session.sub) {
    redirect("/sign-in")
  }

  return (
    <CreateLayout currentStep={1} title="Setup & Inputs">
      <CreateForm />
    </CreateLayout>
  )
} 