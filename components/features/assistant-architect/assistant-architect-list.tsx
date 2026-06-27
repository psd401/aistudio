"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Edit, Eye, Play, Trash2 } from "lucide-react"
import { AssistantArchitectWithRelations } from "@/types"
import { useToast } from "@/components/ui/use-toast"
import { deleteAssistantArchitectAction } from "@/actions/db/assistant-architect-actions"
import { useRouter } from "next/navigation"

interface AssistantArchitectListProps {
  tools: AssistantArchitectWithRelations[]
}

export function AssistantArchitectList({ tools }: AssistantArchitectListProps) {
  const { toast } = useToast()
  const router = useRouter()
  const [isDeleting, setIsDeleting] = useState<number | null>(null)

  async function handleDelete(id: number) {
    try {
      setIsDeleting(id)
      const result = await deleteAssistantArchitectAction(String(id))
      if (result.isSuccess) {
        toast({
          title: "Success",
          description: "Assistant deleted successfully"
        })
        router.refresh()
      } else {
        toast({
          title: "Error",
          description: result.message,
          variant: "destructive"
        })
      }
    } catch (error) {
      console.error("Error deleting assistant", error)
      toast({
        title: "Error",
        description: "Failed to delete assistant",
        variant: "destructive"
      })
    } finally {
      setIsDeleting(null)
    }
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case "draft":
        return <Badge variant="secondary">Draft</Badge>
      case "pending_approval":
        return <Badge variant="warning">Pending Approval</Badge>
      case "approved":
        return <Badge variant="success">Approved</Badge>
      case "rejected":
        return <Badge variant="destructive">Rejected</Badge>
      default:
        return null
    }
  }

  if (tools.length === 0) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-center text-muted-foreground text-sm">No assistants found.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {tools.map((tool) => (
        <Card key={tool.id} className="flex flex-col">
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-lg">{tool.name}</CardTitle>
                <CardDescription className="text-sm">{tool.description}</CardDescription>
              </div>
              {getStatusBadge(tool.status)}
            </div>
          </CardHeader>

          <CardContent>
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-medium mb-2">Input Fields</h4>
                <ul className="list-disc list-inside text-sm">
                  {tool.inputFields.map((field) => (
                    <li key={field.id}>{field.name}</li>
                  ))}
                </ul>
              </div>

              <div>
                <h4 className="text-sm font-medium mb-2">Prompts</h4>
                <ul className="list-disc list-inside text-sm">
                  {tool.prompts.map((prompt) => (
                    <li key={prompt.id}>{prompt.name}</li>
                  ))}
                </ul>
              </div>
            </div>
          </CardContent>

          <div className="mt-4">
            <CardFooter className="flex justify-between mt-auto">
              <div className="flex gap-2">
                {tool.status === "approved" ? (
                  <>
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/utilities/assistant-architect/${tool.id}/edit`}>
                        <Edit className="h-4 w-4 mr-1" />
                        Edit
                      </Link>
                    </Button>
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/tools/assistant-architect/${tool.id}`}>
                        <Play className="h-4 w-4 mr-1" />
                        Execute
                      </Link>
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/utilities/assistant-architect/${tool.id}/edit`}>
                      {tool.status === "draft" || tool.status === "rejected" ? (
                        <>
                          <Edit className="h-4 w-4 mr-1" />
                          Edit
                        </>
                      ) : (
                        <>
                          <Eye className="h-4 w-4 mr-1" />
                          View
                        </>
                      )}
                    </Link>
                  </Button>
                )}
              </div>

              {(tool.status === "draft" || tool.status === "rejected") && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleDelete(tool.id)}
                  disabled={isDeleting === tool.id}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  {isDeleting === tool.id ? "Deleting..." : "Delete"}
                </Button>
              )}
            </CardFooter>
          </div>
        </Card>
      ))}
    </div>
  )
} 