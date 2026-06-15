"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { useToast } from "@/components/ui/use-toast"
import { z } from "zod"
import { useRouter } from "next/navigation"
import {
  createCapabilityAction,
  updateCapabilityAction,
} from "@/actions/admin/capabilities.actions"
import type { CapabilityRow } from "./capabilities-table"

const createSchema = z.object({
  identifier: z
    .string()
    .min(1, "Identifier is required")
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/,
      "Lowercase alphanumeric; may contain '.', '-', '_'"
    ),
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
})

const editSchema = z.object({
  identifier: z.string(),
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
})

type FormValues = z.infer<typeof createSchema>

interface CapabilityFormProps {
  capability: CapabilityRow | null
  onClose: () => void
}

export function CapabilityForm({ capability, onClose }: CapabilityFormProps) {
  const { toast } = useToast()
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  const isEditing = capability !== null
  const isCode = capability?.source === "code"

  const form = useForm<FormValues>({
    resolver: zodResolver(isEditing ? editSchema : createSchema),
    defaultValues: {
      identifier: capability?.identifier ?? "",
      name: capability?.name ?? "",
      description: capability?.description ?? "",
    },
  })

  const onSubmit = async (values: FormValues) => {
    setLoading(true)
    try {
      const result = isEditing
        ? await updateCapabilityAction(capability.id, {
            // For code capabilities, name/description are unchanged (fields are
            // disabled) — the server also rejects any change defensively.
            name: isCode ? undefined : values.name,
            description: isCode ? undefined : values.description ?? "",
          })
        : await createCapabilityAction({
            identifier: values.identifier,
            name: values.name,
            description: values.description ?? "",
          })

      if (!result.isSuccess) {
        throw new Error(result.message)
      }

      toast({
        title: "Success",
        description: isEditing
          ? "Capability updated"
          : "Capability created",
      })
      router.refresh()
      onClose()
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to save capability",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? isCode
                ? "Capability (code-managed)"
                : "Edit Capability"
              : "Create Capability"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="identifier"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Identifier</FormLabel>
                  <FormControl>
                    {/* Identifier is immutable after creation. */}
                    <Input {...field} disabled={loading || isEditing} />
                  </FormControl>
                  <FormDescription>
                    Stable string ID used in access checks. Cannot be changed
                    after creation.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={loading || isCode} />
                  </FormControl>
                  {isCode && (
                    <FormDescription>
                      Managed by the code manifest (read-only).
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea {...field} disabled={loading || isCode} />
                  </FormControl>
                  {isCode && (
                    <FormDescription>
                      Managed by the code manifest (read-only).
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                type="button"
                onClick={onClose}
                disabled={loading}
              >
                {isCode ? "Close" : "Cancel"}
              </Button>
              {!isCode && (
                <Button type="submit" disabled={loading}>
                  {loading ? "Saving..." : isEditing ? "Update" : "Create"}
                </Button>
              )}
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
