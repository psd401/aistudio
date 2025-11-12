/**
 * Zod validation schemas for Prompt Library
 */

import { z } from 'zod'

// Enums
export const promptVisibilitySchema = z.enum(['private', 'public'])

export const moderationStatusSchema = z.enum(['pending', 'approved', 'rejected'])

export const eventTypeSchema = z.enum(['view', 'use', 'share'])

export const sortOptionsSchema = z.enum(['created', 'usage', 'views']).default('created')

// Create Prompt Schema
export const createPromptSchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(255, 'Title must be 255 characters or less'),
  content: z.string()
    .min(1, 'Content is required')
    .max(50000, 'Content must be 50,000 characters or less'),
  description: z.string()
    .max(1000, 'Description must be 1,000 characters or less')
    .optional()
    .nullable(),
  visibility: promptVisibilitySchema.default('private'),
  tags: z.array(z.string().min(1).max(50))
    .max(10, 'Maximum 10 tags allowed')
    .optional(),
  sourceMessageId: z.string().uuid().optional().nullable(),
  sourceConversationId: z.string().uuid().optional().nullable(),
})

export type CreatePromptInput = z.infer<typeof createPromptSchema>

// Update Prompt Schema
export const updatePromptSchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(255, 'Title must be 255 characters or less')
    .optional(),
  content: z.string()
    .min(1, 'Content is required')
    .max(50000, 'Content must be 50,000 characters or less')
    .optional(),
  description: z.string()
    .max(1000, 'Description must be 1,000 characters or less')
    .optional()
    .nullable(),
  visibility: promptVisibilitySchema.optional(),
  tags: z.array(z.string().min(1).max(50))
    .max(10, 'Maximum 10 tags allowed')
    .optional(),
})

export type UpdatePromptInput = z.infer<typeof updatePromptSchema>

// Search/Filter Schema
export const promptSearchSchema = z.object({
  visibility: promptVisibilitySchema.optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().max(200).optional(),
  userId: z.number().int().positive().optional(),
  sort: sortOptionsSchema,
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export type PromptSearchInput = z.infer<typeof promptSearchSchema>

// Moderation Schema
export const moderatePromptSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  notes: z.string().max(1000).optional().nullable(),
})

export type ModeratePromptInput = z.infer<typeof moderatePromptSchema>

// Tag Schema
export const createTagSchema = z.object({
  name: z.string()
    .min(1, 'Tag name is required')
    .max(50, 'Tag name must be 50 characters or less')
    .regex(/^[\d\sA-Za-z-]+$/, 'Tag name can only contain letters, numbers, spaces, and hyphens')
})

export type CreateTagInput = z.infer<typeof createTagSchema>
