"use client"

import { useUser } from "@/components/auth/user-provider"

export default function TestUserPage() {
  const { user, roles, loading } = useUser()

  if (loading) {
    return <div>Loading...</div>
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">User Info</h1>
      
      <div className="mb-4">
        <h2 className="text-xl font-semibold">User:</h2>
        <pre className="bg-muted p-4 rounded">
          {JSON.stringify(user, null, 2)}
        </pre>
      </div>

      <div className="mb-4">
        <h2 className="text-xl font-semibold">Roles:</h2>
        <pre className="bg-muted p-4 rounded">
          {JSON.stringify(roles, null, 2)}
        </pre>
      </div>
    </div>
  )
}