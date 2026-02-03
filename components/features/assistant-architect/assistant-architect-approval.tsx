"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import {
  approveAssistantArchitectAction,
  rejectAssistantArchitectAction
} from "@/actions/db/assistant-architect-actions"
import { Textarea } from "@/components/ui/textarea"
import { Check, X, Edit } from "lucide-react"
import { SelectAssistantArchitect, SelectToolInputField, SelectChainPrompt } from "@/types/db-types"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AssistantPreview } from "@/app/(protected)/utilities/assistant-architect/[id]/edit/preview/_components/assistant-preview"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

interface AssistantArchitectApprovalProps {
  request: SelectAssistantArchitect & {
    inputFields: SelectToolInputField[]
    prompts: SelectChainPrompt[]
  }
  isApproved?: boolean
}

export function AssistantArchitectApproval({
  request,
  isApproved = false
}: AssistantArchitectApprovalProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [rejectionReason, setRejectionReason] = useState("")
  const [showRejectionForm, setShowRejectionForm] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const { toast } = useToast()
  const router = useRouter()

  async function handleApprove() {
    try {
      setIsProcessing(true)
      const result = await approveAssistantArchitectAction(String(request.id))
      if (result.isSuccess) {
        toast({
          title: "Success",
          description: "Assistant approved successfully"
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
      console.error("Error approving assistant:", error)
      toast({
        title: "Error",
        description: "Failed to approve assistant",
        variant: "destructive"
      })
    } finally {
      setIsProcessing(false)
    }
  }

  async function handleReject() {
    if (!rejectionReason) {
      toast({
        title: "Error",
        description: "Please provide a reason for rejection",
        variant: "destructive"
      })
      return
    }

    try {
      setIsProcessing(true)
      const result = await rejectAssistantArchitectAction(String(request.id))
      if (result.isSuccess) {
        toast({
          title: "Success",
          description: "Assistant rejected successfully"
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
      console.error("Error rejecting assistant:", error)
      toast({
        title: "Error",
        description: "Failed to reject assistant",
        variant: "destructive"
      })
    } finally {
      setIsProcessing(false)
      setShowRejectionForm(false)
      setRejectionReason("")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{request.name}</CardTitle>
        <CardDescription className="text-sm">{request.description}</CardDescription>
      </CardHeader>

      <CardContent>
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium mb-2">Input Fields</h4>
            <ul className="list-disc list-inside text-sm">
              {request.inputFields.map((field) => (
                <li key={field.id}>{field.name}</li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-medium mb-2">Prompts</h4>
            <ul className="list-disc list-inside text-sm">
              {request.prompts.map((prompt) => (
                <li key={prompt.id}>{prompt.name}</li>
              ))}
            </ul>
          </div>
        </div>
      </CardContent>

      <CardFooter className="flex justify-end gap-2">
        {isApproved ? (
          <Button variant="outline" asChild>
            <Link href={`/utilities/assistant-architect/${request.id}/edit`}>
              <Edit className="h-4 w-4 mr-2" />
              Edit
            </Link>
          </Button>
        ) : (
          <>
            <Dialog open={showDetails} onOpenChange={setShowDetails}>
              <DialogTrigger asChild>
                <Button variant="outline" onClick={() => setShowDetails(true)}>
                  View Details
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-3xl w-full">
                <DialogHeader>
                  <DialogTitle>Assistant Preview: {request.name}</DialogTitle>
                </DialogHeader>
                <div className="max-h-[70vh] overflow-y-auto">
                  <Tabs defaultValue="preview">
                    <TabsList className="mb-4">
                      <TabsTrigger value="preview">Preview</TabsTrigger>
                      <TabsTrigger value="prompts">Prompts & Context</TabsTrigger>
                    </TabsList>
                    <TabsContent value="preview">
                      <AssistantPreview tool={request} />
                    </TabsContent>
                    <TabsContent value="prompts">
                      <div className="space-y-6">
                        {request.prompts.length === 0 ? (
                          <div className="text-muted-foreground">No prompts defined.</div>
                        ) : (
                          request.prompts.map((prompt) => (
                            <div key={prompt.id} className="border rounded-md p-4 bg-muted/10">
                              <div className="font-semibold text-lg mb-1">{prompt.name}</div>
                              <div className="mb-2">
                                <span className="font-medium">Content:</span>
                                <pre className="whitespace-pre-wrap break-words bg-background p-2 rounded mt-1 text-sm border">
                                  {prompt.content}
                                </pre>
                              </div>
                              {prompt.systemContext && (
                                <div className="mt-2">
                                  <span className="font-medium">System Context:</span>
                                  <pre className="whitespace-pre-wrap break-words bg-background p-2 rounded mt-1 text-xs border">
                                    {prompt.systemContext}
                                  </pre>
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    </TabsContent>
                  </Tabs>
                </div>
              </DialogContent>
            </Dialog>
            {showRejectionForm ? (
              <div className="space-y-4 w-full">
                <Textarea
                  placeholder="Reason for rejection"
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setShowRejectionForm(false)}
                    disabled={isProcessing}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={handleReject}
                    disabled={isProcessing}
                  >
                    Confirm Rejection
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Button
                  variant="destructive"
                  onClick={() => setShowRejectionForm(true)}
                  disabled={isProcessing}
                >
                  <X className="h-4 w-4 mr-2" />
                  Reject
                </Button>
                <Button onClick={handleApprove} disabled={isProcessing}>
                  <Check className="h-4 w-4 mr-2" />
                  Approve
                </Button>
              </>
            )}
          </>
        )}
      </CardFooter>
    </Card>
  )
} 