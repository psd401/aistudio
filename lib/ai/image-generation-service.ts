/**
 * Image Generation Service
 *
 * Handles image generation for both OpenAI and Google providers with:
 * - Provider-specific API handling (generateImage vs generateText)
 * - S3 storage for generated images
 * - Proper error handling for rate limits, content policy, etc.
 *
 * @see Issue #614 - Implement image generation API integration in Nexus chat
 */

import { experimental_generateImage as generateImage, generateText, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createLogger, generateRequestId } from '@/lib/logger';
import { Settings } from '@/lib/settings-manager';
import { ErrorFactories } from '@/lib/error-utils';

// Type for OpenAI image size
type OpenAIImageSize = '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';

// Extended result type for Gemini generateText with files
// This is a simplified interface that doesn't extend GenerateTextResult to avoid complex type issues
interface GeminiGenerateTextResult {
  text: string;
  files?: Array<Uint8Array | { data?: Uint8Array; uint8Array?: Uint8Array; mimeType?: string; mediaType?: string }>;
  experimental_output?: {
    files?: Array<Uint8Array | { data?: Uint8Array; uint8Array?: Uint8Array; mimeType?: string; mediaType?: string }>;
  };
}

const log = createLogger({ module: 'image-generation-service' });

// Initialize S3 client
const s3Client = new S3Client({});

export interface ImageGenerationRequest {
  prompt: string;
  modelId: string;
  provider: 'openai' | 'google';
  conversationId: string;
  userId: string;
  size?: string;
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
}

export interface ImageGenerationResult {
  imageUrl: string;
  s3Key: string;
  provider: string;
  model: string;
  altText?: string;
  dimensions?: { width: number; height: number };
  estimatedCost?: number;
}

export interface ImageGenerationError {
  type: 'CONTENT_POLICY' | 'RATE_LIMIT' | 'AUTHENTICATION' | 'INVALID_SIZE' | 'NO_IMAGE' | 'STORAGE_ERROR' | 'UNKNOWN';
  message: string;
  retryAfter?: number;
  details?: string;
}

/**
 * Get the documents bucket name from environment
 */
function getDocumentsBucket(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.DOCUMENTS_BUCKET_NAME || 'test-documents-bucket';
  }

  if (!process.env.DOCUMENTS_BUCKET_NAME) {
    throw new Error('DOCUMENTS_BUCKET_NAME environment variable is required');
  }

  return process.env.DOCUMENTS_BUCKET_NAME;
}

/**
 * Main entry point for image generation
 * Routes to appropriate provider implementation
 */
export async function generateImageForNexus(
  request: ImageGenerationRequest
): Promise<ImageGenerationResult> {
  const requestId = generateRequestId();
  log.info('Starting image generation', {
    requestId,
    provider: request.provider,
    modelId: request.modelId,
    promptLength: request.prompt.length,
    conversationId: request.conversationId
  });

  try {
    let result: ImageGenerationResult;

    if (request.provider === 'openai') {
      result = await generateWithOpenAI(request, requestId);
    } else if (request.provider === 'google') {
      result = await generateWithGemini(request, requestId);
    } else {
      throw ErrorFactories.sysConfigurationError(`Unsupported image generation provider: ${request.provider}`);
    }

    log.info('Image generation completed', {
      requestId,
      provider: request.provider,
      s3Key: result.s3Key
    });

    return result;
  } catch (error) {
    log.error('Image generation failed', {
      requestId,
      provider: request.provider,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * Generate image using OpenAI's gpt-image-1.5 or similar models
 * Uses AI SDK's experimental_generateImage function
 */
async function generateWithOpenAI(
  request: ImageGenerationRequest,
  requestId: string
): Promise<ImageGenerationResult> {
  log.debug('Generating image with OpenAI', { requestId, modelId: request.modelId });

  try {
    const apiKey = await Settings.getOpenAI();
    if (!apiKey) {
      throw ErrorFactories.sysConfigurationError('OpenAI API key not configured');
    }

    const openai = createOpenAI({ apiKey });

    // Determine if this is a valid image model
    const imageModelId = request.modelId.includes('image') || request.modelId.includes('dall-e')
      ? request.modelId
      : 'gpt-image-1'; // Default to gpt-image-1 if modelId doesn't specify

    const imageModel = openai.image(imageModelId);

    // Build provider options for quality and style
    // Map size string to valid OpenAI size type
    const sizeMap: Record<string, OpenAIImageSize> = {
      '256x256': '256x256',
      '512x512': '512x512',
      '1024x1024': '1024x1024',
      '1792x1024': '1792x1024',
      '1024x1792': '1024x1792'
    };
    const imageSize: OpenAIImageSize = sizeMap[request.size || '1024x1024'] || '1024x1024';

    // Generate the image
    const result = await generateImage({
      model: imageModel,
      prompt: request.prompt,
      n: 1,
      size: imageSize,
      providerOptions: {
        openai: {
          ...(request.quality && { quality: request.quality }),
          ...(request.style && { style: request.style })
        }
      }
    });

    // Extract the generated image
    const generatedImage = result.images?.[0];
    if (!generatedImage) {
      throw createImageError('NO_IMAGE', 'OpenAI returned no image');
    }

    // Get image data (prefer base64, fallback to uint8Array)
    let imageBuffer: Buffer;
    if (generatedImage.base64) {
      imageBuffer = Buffer.from(generatedImage.base64, 'base64');
    } else if (generatedImage.uint8Array) {
      imageBuffer = Buffer.from(generatedImage.uint8Array);
    } else {
      throw createImageError('NO_IMAGE', 'No image data in OpenAI response');
    }

    // Store in S3
    const s3Result = await storeImageInS3({
      imageBuffer,
      conversationId: request.conversationId,
      userId: request.userId,
      provider: 'openai',
      modelId: request.modelId,
      contentType: 'image/png'
    });

    // Estimate cost based on model
    const estimatedCost = getOpenAICost(request.modelId, request.size, request.quality);

    return {
      imageUrl: s3Result.presignedUrl,
      s3Key: s3Result.s3Key,
      provider: 'openai',
      model: request.modelId,
      dimensions: parseDimensions(request.size || '1024x1024'),
      estimatedCost
    };

  } catch (error) {
    // Handle OpenAI-specific errors
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('content_policy') || errorMessage.includes('safety')) {
      throw createImageError('CONTENT_POLICY', 'Your image prompt was rejected by content policy');
    }

    if (errorMessage.includes('rate_limit') || errorMessage.includes('429')) {
      const retryMatch = errorMessage.match(/retry after (\d+)/i);
      throw createImageError('RATE_LIMIT', 'Rate limit exceeded', retryMatch ? parseInt(retryMatch[1]) : 60);
    }

    if (errorMessage.includes('invalid_api_key') || errorMessage.includes('authentication')) {
      throw createImageError('AUTHENTICATION', 'OpenAI authentication failed');
    }

    if (errorMessage.includes('invalid_image_size')) {
      throw createImageError('INVALID_SIZE', 'Invalid image size. Use 1024x1024, 1792x1024, or 1024x1792');
    }

    throw error;
  }
}

/**
 * Generate image using Google's Gemini image models
 * CRITICAL: Uses generateText() NOT generateImage() - Gemini returns images in result.files
 *
 * @see https://ai-sdk.dev/cookbook/guides/google-gemini-image-generation
 */
async function generateWithGemini(
  request: ImageGenerationRequest,
  requestId: string
): Promise<ImageGenerationResult> {
  log.debug('Generating image with Gemini', { requestId, modelId: request.modelId });

  try {
    const apiKey = await Settings.getGoogleAI();
    if (!apiKey) {
      throw ErrorFactories.sysConfigurationError('Google API key not configured');
    }

    const google = createGoogleGenerativeAI({ apiKey });

    // Determine the image model - use gemini-2.5-flash-image as default
    const imageModelId = request.modelId.includes('image')
      ? request.modelId
      : 'gemini-2.5-flash-image';

    // CRITICAL: Gemini image models use generateText with responseModalities
    const model = google(imageModelId);

    // Generate using generateText (NOT generateImage)
    const textResult = await generateText({
      model: model as LanguageModel,
      prompt: request.prompt,
      providerOptions: {
        google: {
          responseModalities: ['TEXT', 'IMAGE'] // REQUIRED for image output
        }
      }
    });

    // Cast to extended result type that includes files
    const result = textResult as unknown as GeminiGenerateTextResult;

    // Extract image from result.files
    const files = result.files || result.experimental_output?.files || [];

    if (!files || files.length === 0) {
      log.warn('Gemini returned no image files', {
        requestId,
        hasText: !!result.text,
        textLength: result.text?.length || 0
      });
      throw createImageError('NO_IMAGE', 'Gemini did not generate an image. Try a different prompt.');
    }

    // Find the first image file
    let imageData: Uint8Array | undefined;
    let contentType = 'image/png';

    for (const file of files) {
      // Files can be Uint8Array directly or objects with data
      if (file instanceof Uint8Array) {
        imageData = file;
        break;
      } else if (typeof file === 'object' && file !== null) {
        const fileObj = file as { data?: Uint8Array; uint8Array?: Uint8Array; mimeType?: string; mediaType?: string };
        if (fileObj.data) {
          imageData = fileObj.data;
          contentType = fileObj.mimeType || fileObj.mediaType || 'image/png';
          break;
        } else if (fileObj.uint8Array) {
          imageData = fileObj.uint8Array;
          contentType = fileObj.mimeType || fileObj.mediaType || 'image/png';
          break;
        }
      }
    }

    if (!imageData) {
      throw createImageError('NO_IMAGE', 'Could not extract image data from Gemini response');
    }

    const imageBuffer = Buffer.from(imageData);

    // Store in S3
    const s3Result = await storeImageInS3({
      imageBuffer,
      conversationId: request.conversationId,
      userId: request.userId,
      provider: 'google',
      modelId: request.modelId,
      contentType
    });

    return {
      imageUrl: s3Result.presignedUrl,
      s3Key: s3Result.s3Key,
      provider: 'google',
      model: request.modelId,
      altText: result.text, // Gemini always returns text description
      estimatedCost: 0 // Gemini image pricing TBD
    };

  } catch (error) {
    // Handle Gemini-specific errors
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('SAFETY') || errorMessage.includes('safety')) {
      throw createImageError('CONTENT_POLICY', 'Gemini safety filter rejected the prompt');
    }

    if (errorMessage.includes('QUOTA_EXCEEDED') || errorMessage.includes('quota')) {
      throw createImageError('RATE_LIMIT', 'Google AI quota exceeded');
    }

    if (errorMessage.includes('RECITATION')) {
      throw createImageError('CONTENT_POLICY', 'Prompt too similar to existing content');
    }

    if (errorMessage.includes('responseModalities')) {
      throw createImageError('INVALID_SIZE', 'Model not configured for image generation');
    }

    throw error;
  }
}

/**
 * Store generated image in S3 and return presigned URL
 */
async function storeImageInS3(params: {
  imageBuffer: Buffer;
  conversationId: string;
  userId: string;
  provider: string;
  modelId: string;
  contentType: string;
}): Promise<{ s3Key: string; presignedUrl: string }> {
  const bucket = getDocumentsBucket();
  const timestamp = Date.now();
  const sanitizedModelId = params.modelId.replace(/[^a-zA-Z0-9-]/g, '-');

  // Create S3 key with proper path structure
  const s3Key = `v2/generated-images/${params.conversationId}/${timestamp}-${sanitizedModelId}.png`;

  try {
    // Upload to S3
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: params.imageBuffer,
      ContentType: params.contentType,
      Metadata: {
        conversationId: params.conversationId,
        userId: params.userId,
        provider: params.provider,
        modelId: params.modelId,
        generatedAt: new Date().toISOString()
      }
    }));

    log.debug('Image stored in S3', { s3Key, size: params.imageBuffer.length });

    // Generate presigned URL (valid for 7 days)
    const presignedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: s3Key
      }),
      { expiresIn: 7 * 24 * 60 * 60 } // 7 days
    );

    return { s3Key, presignedUrl };

  } catch (error) {
    log.error('Failed to store image in S3', {
      s3Key,
      error: error instanceof Error ? error.message : String(error)
    });
    throw createImageError('STORAGE_ERROR', 'Failed to store generated image');
  }
}

/**
 * Create a typed image generation error
 */
function createImageError(
  type: ImageGenerationError['type'],
  message: string,
  retryAfter?: number
): Error & ImageGenerationError {
  const error = new Error(message) as Error & ImageGenerationError;
  error.type = type;
  error.message = message;
  if (retryAfter) {
    error.retryAfter = retryAfter;
  }
  return error;
}

/**
 * Parse dimensions from size string
 */
function parseDimensions(size: string): { width: number; height: number } {
  const parts = size.split('x');
  return {
    width: parseInt(parts[0]) || 1024,
    height: parseInt(parts[1]) || 1024
  };
}

/**
 * Estimate OpenAI image generation cost
 */
function getOpenAICost(modelId: string, size?: string, quality?: string): number {
  // Cost per image based on model and options (as of 2026)
  const baseCosts: Record<string, number> = {
    'gpt-image-1.5': 0.133,
    'gpt-image-1': 0.080,
    'gpt-image-1-mini': 0.040,
    'dall-e-3': 0.080,
    'dall-e-2': 0.020
  };

  let cost = baseCosts[modelId] || 0.080;

  // HD quality costs more
  if (quality === 'hd') {
    cost *= 1.5;
  }

  // Larger sizes cost more
  if (size === '1792x1024' || size === '1024x1792') {
    cost *= 1.25;
  }

  return cost;
}

/**
 * Check if a model ID is an image generation model
 */
export function isImageGenerationModel(modelId: string): boolean {
  const imagePatterns = [
    'gpt-image',
    'dall-e',
    'gemini-2.5-flash-image',
    'gemini-3-pro-image',
    'imagen'
  ];

  const lowerModelId = modelId.toLowerCase();
  return imagePatterns.some(pattern => lowerModelId.includes(pattern));
}
