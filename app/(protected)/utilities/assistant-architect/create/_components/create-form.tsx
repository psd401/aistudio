"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { createAssistantArchitectAction, updateAssistantArchitectAction } from "@/actions/db/assistant-architect-actions"
import { useToast } from "@/components/ui/use-toast"
import { SelectAssistantArchitect } from "@/types/db-types"
import Image from "next/image"

interface CreateFormProps {
  initialData?: SelectAssistantArchitect
}

// Form schema
const formSchema = z.object({
  name: z.string().min(3, {
    message: "Name must be at least 3 characters.",
  }),
  description: z.string().optional(),
  imagePath: z.string().min(1, {
    message: "Please select an image for your assistant.",
  }),
})

type FormValues = z.infer<typeof formSchema>

export function CreateForm({ initialData }: CreateFormProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [images, setImages] = useState<string[]>([])

  useEffect(() => {
    // Get list of images from the assistant_logos directory
    fetch("/api/assistant-images")
      .then(res => res.json())
      .then(data => setImages(data.images))
      .catch(() => setImages([]))
  }, [])

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initialData?.name || "",
      description: initialData?.description || "",
      imagePath: initialData?.imagePath || ""
    }
  })

  async function onSubmit(values: FormValues) {
    try {
      setIsSubmitting(true)
      
      let result
      if (initialData) {
        // Update existing assistant
        result = await updateAssistantArchitectAction(String(initialData.id), values)
        if (!result.isSuccess) {
          throw new Error(result.message)
        }
        
        toast({
          title: "Success",
          description: "Assistant updated successfully"
        })
        
        // Navigate to input fields step
        router.push(`/utilities/assistant-architect/${initialData.id}/edit/input-fields`)
      } else {
        // Create new assistant
        result = await createAssistantArchitectAction({
          name: values.name,
          description: values.description || "",
          imagePath: values.imagePath,
          status: "draft"
        })
        
        if (!result.isSuccess) {
          throw new Error(result.message)
        }

        toast({
          title: "Success",
          description: "Assistant created successfully"
        })

        // Navigate to input fields step
        router.push(`/utilities/assistant-architect/${result.data.id}/edit/input-fields`)
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save assistant",
        variant: "destructive"
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Enter assistant name..." {...field} />
              </FormControl>
              <FormDescription>
                A descriptive name for your assistant.
              </FormDescription>
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
                <Textarea
                  placeholder="Enter assistant description..."
                  {...field}
                />
              </FormControl>
              <FormDescription>
                A brief description of what your assistant does.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="imagePath"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Assistant Image</FormLabel>
              <FormControl>
                <div className="relative">
                  <div className="grid grid-cols-10 gap-1 p-1 bg-muted rounded-lg h-[250px] overflow-y-auto">
                    {images.map((image) => (
                      <div 
                        key={image}
                        className="group relative"
                      >
                        <div
                          className={`relative aspect-square cursor-pointer rounded-md overflow-hidden border transition-all ${
                            field.value === image ? 'border-primary ring-1 ring-primary' : 'border-transparent hover:border-muted-foreground'
                          }`}
                          onClick={() => field.onChange(image)}
                          onKeyDown={(e) => e.key === 'Enter' && field.onChange(image)}
                          role="button"
                          tabIndex={0}
                          style={{ width: '40px', height: '40px' }}
                        >
                          <Image
                            src={`/assistant_logos/${image}`}
                            alt={image}
                            fill
                            className="object-cover"
                            sizes="40px"
                          />
                        </div>
                        {/* Hover Preview */}
                        <div className="fixed z-[100] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                          <div 
                            className="absolute w-32 h-32 rounded-lg overflow-hidden shadow-lg ring-1 ring-black/10 bg-white"
                            style={{
                              bottom: 'calc(100% + 10px)',
                              left: '50%',
                              transform: 'translateX(-50%)'
                            }}
                          >
                            <Image
                              src={`/assistant_logos/${image}`}
                              alt={image}
                              fill
                              className="object-cover"
                              sizes="128px"
                            />
                            <div className="absolute -bottom-1 left-1/2 w-2 h-2 -translate-x-1/2 rotate-45 bg-white ring-1 ring-black/10"></div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </FormControl>
              <FormDescription>
                Select an image for your assistant.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving..." : "Continue"}
        </Button>
      </form>
    </Form>
  )
} 