import { z } from 'zod';

/**
 * Common validation schemas for API routes
 */

// Common ID schemas
export const numericIdSchema = z.string().regex(/^\d+$/, 'Invalid numeric ID');
export const uuidSchema = z.string().uuid('Invalid UUID');

// Pagination schemas
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10)
});

// User schemas
export const createUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  firstName: z.string().min(1, 'First name is required').max(100),
  lastName: z.string().min(1, 'Last name is required').max(100),
  role: z.string().min(1, 'Role is required')
});

export const updateUserSchema = z.object({
  email: z.string().email('Invalid email address').optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional()
});

export const updateUserRoleSchema = z.object({
  role: z.string().min(1, 'Role is required')
});

// Role schemas
export const createRoleSchema = z.object({
  name: z.string().min(1, 'Role name is required').max(50),
  description: z.string().max(500).optional()
});

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  description: z.string().max(500).optional()
});

// AI Model schemas
export const createModelSchema = z.object({
  name: z.string().min(1, 'Model name is required').max(100),
  modelId: z.string().min(1, 'Model ID is required').max(100),
  provider: z.string().min(1, 'Provider is required').max(50),
  description: z.string().max(500).optional(),
  capabilities: z.array(z.string()).optional(),
  maxTokens: z.string().regex(/^\d+$/).optional(),
  active: z.boolean().optional(),
  nexusEnabled: z.boolean().optional(),
  architectEnabled: z.boolean().optional()
});

export const updateModelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(100).optional(),
  provider: z.string().min(1).max(50).optional(),
  description: z.string().max(500).optional(),
  capabilities: z.array(z.string()).optional(),
  maxTokens: z.string().regex(/^\d+$/).optional(),
  active: z.boolean().optional(),
  nexusEnabled: z.boolean().optional(),
  architectEnabled: z.boolean().optional()
});

// Navigation schemas
export const createNavigationSchema = z.object({
  label: z.string().min(1, 'Label is required').max(100),
  icon: z.string().max(50).optional(),
  link: z.string().max(255).optional(),
  description: z.string().max(500).optional(),
  type: z.enum(['page', 'divider', 'tool']),
  parentId: z.number().int().positive().optional(),
  toolId: z.number().int().positive().optional(),
  requiresRole: z.string().max(50).optional(),
  position: z.number().int().min(0).optional(),
  isActive: z.boolean().optional()
});

export const updateNavigationSchema = createNavigationSchema.partial();

export const updateNavigationOrderSchema = z.object({
  items: z.array(z.object({
    id: z.number().int().positive(),
    position: z.number().int().min(0)
  }))
});

// Settings schemas
export const createSettingsSchema = z.object({
  provider: z.string().min(1, 'Provider is required').max(50),
  model: z.string().min(1, 'Model is required').max(100),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  apiKey: z.string().min(1).max(500).optional(),
  region: z.string().max(50).optional()
});

export const updateSettingsSchema = createSettingsSchema.partial();

// Chat schemas
export const createChatMessageSchema = z.object({
  message: z.string().min(1, 'Message is required').max(10000),
  conversationId: z.string().optional(),
  documentId: z.string().optional(),
  parentMessageId: z.string().optional()
});

export const createConversationSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  systemPrompt: z.string().max(2000).optional(),
  modelId: z.number().int().positive().optional()
});

export const updateConversationSchema = z.object({
  name: z.string().min(1).max(255).optional()
});

// Document schemas
// Note: File validation is handled at runtime in the route handler
// since File class is not available during SSR/build
export const uploadDocumentSchema = z.object({
  file: z.any() // Runtime validation is done in the route handler
});

// Job schemas
export const updateJobSchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  output: z.any().optional(),
  error: z.string().optional()
});

// Assistant Architect schemas
export const createAssistantSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().max(1000).optional(),
  imagePath: z.string().max(500).optional()
});

export const updateAssistantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  imagePath: z.string().max(500).optional()
});

// Tool input field schemas
export const createToolInputFieldSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  label: z.string().max(200).optional(),
  type: z.enum(['text', 'number', 'select', 'boolean', 'date']),
  position: z.number().int().min(0).optional(),
  options: z.array(z.object({
    label: z.string(),
    value: z.string()
  })).optional()
});

// Graph metadata schema (shared across graph API routes and decision-capture-service)
export const GRAPH_METADATA_MAX_BYTES = 10_240

export const graphMetadataSchema = z.record(z.string(), z.unknown()).refine(
  (val) => JSON.stringify(val).length <= GRAPH_METADATA_MAX_BYTES,
  { message: `Metadata must be ${GRAPH_METADATA_MAX_BYTES} bytes or less when serialized` }
)

// Generic ID parameter schema for route params
export const idParamSchema = z.object({
  id: z.string()
});

export const userIdParamSchema = z.object({
  userId: z.string()
});

export const roleIdParamSchema = z.object({
  roleId: z.string()
});

export const toolIdParamSchema = z.object({
  toolId: z.string()
});

export const conversationIdParamSchema = z.object({
  conversationId: z.string()
});

/**
 * Helper function to validate request body with Zod schema
 */
export async function validateRequest<T>(
  request: Request,
  schema: z.ZodSchema<T>
): Promise<{ data: T | null; error: string | null }> {
  try {
    const body = await request.json();
    const result = schema.safeParse(body);
    
    if (!result.success) {
      const errors = result.error.issues.map((e: { path: PropertyKey[]; message: string }) => `${e.path.join('.')}: ${e.message}`).join(', ');
      return { data: null, error: errors };
    }
    
    return { data: result.data, error: null };
  } catch {
    return { data: null, error: 'Invalid JSON body' };
  }
}

/**
 * Helper function to validate query parameters with Zod schema
 */
export function validateSearchParams<T>(
  searchParams: URLSearchParams,
  schema: z.ZodSchema<T>
): { data: T | null; error: string | null } {
  const params = Object.fromEntries(searchParams.entries());
  const result = schema.safeParse(params);

  if (!result.success) {
    const errors = result.error.issues.map((e: { path: PropertyKey[]; message: string }) => `${e.path.join('.')}: ${e.message}`).join(', ');
    return { data: null, error: errors };
  }

  return { data: result.data, error: null };
}

/**
 * Normalize boolean values from various input types
 *
 * Handles common cases from form submissions and API requests:
 * - String "false", "0" → false
 * - Numeric 0 → false
 * - Boolean false → false
 * - Everything else → true (via Boolean coercion)
 *
 * @param value - Value to normalize (unknown type from API)
 * @returns Normalized boolean value
 *
 * @example
 * normalizeBoolean(true) // true
 * normalizeBoolean("true") // true
 * normalizeBoolean(false) // false
 * normalizeBoolean("false") // false
 * normalizeBoolean("0") // false
 * normalizeBoolean(0) // false
 * normalizeBoolean("") // false (empty string is falsy)
 * normalizeBoolean(null) // false
 * normalizeBoolean(undefined) // false
 */
export function normalizeBoolean(value: unknown): boolean {
  // Handle actual boolean type
  if (typeof value === 'boolean') {
    return value;
  }

  // Explicit false cases: string "false", string "0", number 0
  if (value === 'false' || value === '0' || value === 0) {
    return false;
  }

  // Falsy values (null, undefined, "", NaN) → false
  // Truthy values (non-empty strings, objects, arrays) → true
  return Boolean(value);
}