import { z } from 'zod';

/**
 * Shared Zod schema for document upload validation.
 * Ensures consistent validation across initiate-upload and direct-upload endpoints.
 */
export const UploadRequestSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().positive().max(500 * 1024 * 1024), // 500MB max
  fileType: z.string().min(1),
  purpose: z.enum(['chat', 'repository', 'assistant']),
  processingOptions: z.object({
    extractText: z.boolean().default(true),
    convertToMarkdown: z.boolean().default(false),
    extractImages: z.boolean().default(false),
    generateEmbeddings: z.boolean().default(false),
    ocrEnabled: z.boolean().default(true),
  }).optional(),
}).superRefine((data, ctx) => {
  // Validate processing options based on file size and type to prevent resource exhaustion
  const { fileSize, fileType, processingOptions } = data;

  if (!processingOptions) return; // No validation needed if no options provided

  // Embedding generation limits: Disable for files over 50MB to prevent API quota exhaustion
  if (processingOptions.generateEmbeddings && fileSize > 50 * 1024 * 1024) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['processingOptions', 'generateEmbeddings'],
      message: 'Embedding generation is disabled for files over 50MB to prevent API quota exhaustion'
    });
  }

  // Image extraction limits: Only for PDFs and disable for files over 25MB
  if (processingOptions.extractImages) {
    if (!fileType.includes('pdf')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['processingOptions', 'extractImages'],
        message: 'Image extraction is only supported for PDF files'
      });
    } else if (fileSize > 25 * 1024 * 1024) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['processingOptions', 'extractImages'],
        message: 'Image extraction is disabled for PDF files over 25MB to prevent memory exhaustion'
      });
    }
  }

  // Multiple expensive operations on large files
  const expensiveOpsCount = [
    processingOptions.ocrEnabled,
    processingOptions.generateEmbeddings,
    processingOptions.extractImages,
    processingOptions.convertToMarkdown
  ].filter(Boolean).length;

  if (expensiveOpsCount > 2 && fileSize > 10 * 1024 * 1024) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['processingOptions'],
      message: 'Maximum 2 expensive operations allowed for files over 10MB to prevent resource exhaustion'
    });
  }
});

export type UploadRequest = z.infer<typeof UploadRequestSchema>;
