import { z } from 'zod';
import { streamText } from 'ai';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger';
import { executeQuery } from '@/lib/db/drizzle-client';
import { eq, inArray } from 'drizzle-orm';
import { modelComparisons, aiModels } from '@/lib/db/schema';
import { hasToolAccess } from '@/utils/roles';
import { createProviderModel } from '@/lib/ai/provider-factory';
import { hasCapability } from '@/lib/ai/capability-utils';
import { generateImageForNexus } from '@/lib/ai/image-generation-service';
import type { ImageGenerationError } from '@/lib/ai/image-generation-service';
import { mergeResponseGenerators, asyncGeneratorToStream, type DualStreamEvent } from '@/lib/compare/dual-stream-merger';
import { isTransientStreamError } from '@/lib/streaming/provider-adapters/base-adapter';

// Allow streaming responses up to 5 minutes
export const maxDuration = 300;

// Input validation schema for compare requests
const CompareRequestSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required').max(10000, 'Prompt too long'),
  model1Id: z.string().min(1, 'Model 1 ID is required'),
  model2Id: z.string().min(1, 'Model 2 ID is required'),
  model1Name: z.string().optional(),
  model2Name: z.string().optional()
});

/** DB model config row returned by the model query */
interface ModelConfig {
  id: number | string;
  provider: string | null;
  modelId: string | null;
  name: string | null;
  nexusEnabled: boolean | null;
  capabilities: string | null;
}

/**
 * Async generator for a text-based model response.
 * Streams text chunks, then saves to DB and emits finish.
 */
async function* createTextGenerator(
  modelSlot: 'model1' | 'model2',
  modelConfig: ModelConfig,
  prompt: string,
  comparisonId: number,
  timerStartTime: number,
  log: ReturnType<typeof createLogger>
): AsyncGenerator<DualStreamEvent> {
  const slotNum = modelSlot === 'model1' ? 1 : 2;

  try {
    const model = await createProviderModel(
      String(modelConfig.provider),
      String(modelConfig.modelId)
    );

    const streamResult = streamText({
      model,
      messages: [{ role: 'user', content: prompt }],
    });

    for await (const chunk of streamResult.textStream) {
      yield { modelId: modelSlot, type: 'content', chunk };
    }

    const result = await streamResult;
    const usage = await result.usage;
    const finishReason = await result.finishReason;
    const text = await result.text;

    // Persist response to DB
    try {
      if (slotNum === 1) {
        await executeQuery(
          (db) => db.update(modelComparisons)
            .set({
              response1: text,
              executionTimeMs1: Date.now() - timerStartTime,
              tokensUsed1: usage?.totalTokens || 0,
              updatedAt: new Date()
            })
            .where(eq(modelComparisons.id, comparisonId)),
          'saveModel1Response'
        );
      } else {
        await executeQuery(
          (db) => db.update(modelComparisons)
            .set({
              response2: text,
              executionTimeMs2: Date.now() - timerStartTime,
              tokensUsed2: usage?.totalTokens || 0,
              updatedAt: new Date()
            })
            .where(eq(modelComparisons.id, comparisonId)),
          'saveModel2Response'
        );
      }

      log.info(`Model ${slotNum} text response saved`, {
        comparisonId,
        textLength: text.length,
        finishReason
      });
    } catch (dbError) {
      log.error(`Failed to save model ${slotNum} text response`, {
        comparisonId,
        error: dbError instanceof Error ? dbError.message : String(dbError)
      });
    }

    const finishEvent: DualStreamEvent = {
      modelId: modelSlot,
      type: 'finish',
      finishReason: finishReason ?? 'stop',
      usage: usage
        ? {
            promptTokens: usage.inputTokens || 0,
            completionTokens: usage.outputTokens || 0,
            totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0)
          }
        : undefined
    };
    yield finishEvent;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTransient = error instanceof Error && isTransientStreamError(error);

    if (isTransient) {
      log.warn(`Model ${slotNum} text stream failed (transient)`, { comparisonId, error: errorMessage });
      yield { modelId: modelSlot, type: 'warning', warning: 'Comparison unavailable — model response could not be generated' };
    } else {
      log.error(`Model ${slotNum} text stream failed`, { comparisonId, error: errorMessage });
      yield { modelId: modelSlot, type: 'error', error: 'Stream processing failed' };
    }
    yield { modelId: modelSlot, type: 'finish', finishReason: 'error' };
  }
}

/**
 * Async generator for an image-generation model response.
 * Emits a single image event, then saves to DB and emits finish.
 */
async function* createImageGenerator(
  modelSlot: 'model1' | 'model2',
  modelConfig: ModelConfig,
  prompt: string,
  userId: string,
  comparisonId: number,
  timerStartTime: number,
  log: ReturnType<typeof createLogger>
): AsyncGenerator<DualStreamEvent> {
  const slotNum = modelSlot === 'model1' ? 1 : 2;
  const provider = String(modelConfig.provider) === 'google' ? 'google' : 'openai';

  try {
    log.info(`Model ${slotNum} image generation started`, {
      comparisonId,
      provider,
      modelId: String(modelConfig.modelId)
    });

    const result = await generateImageForNexus({
      prompt,
      modelId: String(modelConfig.modelId),
      provider,
      conversationId: `compare-${comparisonId}`,
      userId,
    });

    // Persist image URL to DB
    try {
      if (slotNum === 1) {
        await executeQuery(
          (db) => db.update(modelComparisons)
            .set({
              response1: result.imageUrl,
              executionTimeMs1: Date.now() - timerStartTime,
              updatedAt: new Date()
            })
            .where(eq(modelComparisons.id, comparisonId)),
          'saveModel1ImageResponse'
        );
      } else {
        await executeQuery(
          (db) => db.update(modelComparisons)
            .set({
              response2: result.imageUrl,
              executionTimeMs2: Date.now() - timerStartTime,
              updatedAt: new Date()
            })
            .where(eq(modelComparisons.id, comparisonId)),
          'saveModel2ImageResponse'
        );
      }

      log.info(`Model ${slotNum} image response saved`, { comparisonId, s3Key: result.s3Key });
    } catch (dbError) {
      log.error(`Failed to save model ${slotNum} image response`, {
        comparisonId,
        error: dbError instanceof Error ? dbError.message : String(dbError)
      });
    }

    yield { modelId: modelSlot, type: 'image', imageUrl: result.imageUrl };
    yield { modelId: modelSlot, type: 'finish', finishReason: 'stop' };
  } catch (error) {
    const errorType: string =
      error instanceof Error && 'type' in error
        ? String((error as Error & Partial<ImageGenerationError>).type ?? 'UNKNOWN')
        : 'UNKNOWN';
    const errorMessage = error instanceof Error ? error.message : String(error);

    log.error(`Model ${slotNum} image generation failed`, {
      comparisonId,
      errorType,
      error: errorMessage
    });

    // Send user-friendly error message based on failure type
    let clientMessage: string;
    if (errorType === 'CONTENT_POLICY') {
      clientMessage = 'Image prompt was rejected by content policy. Please revise your prompt.';
    } else if (errorType === 'RATE_LIMIT') {
      clientMessage = 'Image generation rate limit reached. Please try again in a moment.';
    } else {
      clientMessage = 'Image generation failed. Please try again or select a different model.';
    }

    yield { modelId: modelSlot, type: 'error', error: clientMessage };
    yield { modelId: modelSlot, type: 'finish', finishReason: 'error' };
  }
}

/**
 * Compare Models API - Native Dual Streaming
 * Streams responses from two models in parallel using Server-Sent Events.
 * Supports both text-generation and image-generation models.
 */
export async function POST(req: Request) {
  const requestId = generateRequestId();
  const timer = startTimer('api.compare');
  const timerStartTime = Date.now();
  const log = createLogger({ requestId, route: 'api.compare' });

  log.info('POST /api/compare - Processing model comparison request with native streaming');

  try {
    // 1. Parse and validate request
    const body = await req.json();

    const validationResult = CompareRequestSchema.safeParse(body);
    if (!validationResult.success) {
      log.warn('Invalid request format', {
        errors: validationResult.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
      return new Response(
        JSON.stringify({
          error: 'Invalid request format',
          details: validationResult.error.issues,
          requestId
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { prompt, model1Id, model2Id, model1Name, model2Name } = validationResult.data;

    log.info('Request parsed', sanitizeForLogging({
      promptLength: prompt.length,
      model1Id,
      model2Id,
      hasModel1Name: !!model1Name,
      hasModel2Name: !!model2Name
    }));

    // 2. Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request - no session');
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response('Unauthorized', { status: 401 });
    }

    // 3. Check tool access
    const hasAccess = await hasToolAccess("model-compare");
    if (!hasAccess) {
      log.warn('Model compare access denied', { userId: session.sub });
      timer({ status: 'error', reason: 'access_denied' });
      return new Response('Access denied', { status: 403 });
    }

    // 4. Get current user
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user');
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = currentUser.data.user.id;

    // 5. Validate both models exist and are active
    log.debug('Querying for models', { model1Id, model2Id });

    const modelsResult = await executeQuery(
      (db) => db.select({
        id: aiModels.id,
        provider: aiModels.provider,
        modelId: aiModels.modelId,
        name: aiModels.name,
        nexusEnabled: aiModels.nexusEnabled,
        capabilities: aiModels.capabilities,
      })
      .from(aiModels)
      .where(inArray(aiModels.modelId, [model1Id, model2Id])),
      'getModelsForComparison'
    );

    log.debug('Database query results', {
      foundCount: modelsResult.length,
      foundModels: modelsResult.map(m => ({
        id: m.id,
        modelId: m.modelId,
        name: m.name,
        provider: m.provider,
        nexusEnabled: m.nexusEnabled
      }))
    });

    if (modelsResult.length === 0) {
      log.error('No models found', { model1Id, model2Id });
      return new Response(
        JSON.stringify({ error: 'No models found with the provided IDs' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (modelsResult.length !== 2) {
      log.error('Incomplete model set found', {
        model1Id,
        model2Id,
        foundCount: modelsResult.length,
        foundModelIds: modelsResult.map(m => String(m.modelId))
      });
      return new Response(
        JSON.stringify({
          error: 'One or both selected models not found',
          details: {
            requested: [model1Id, model2Id],
            found: modelsResult.map(m => String(m.modelId))
          }
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Use String() to ensure type consistency for comparison
    const model1Config = modelsResult.find(m => String(m.modelId) === String(model1Id));
    const model2Config = modelsResult.find(m => String(m.modelId) === String(model2Id));

    if (!model1Config || !model2Config) {
      log.error('Model configuration mismatch after type conversion', {
        model1Id: String(model1Id),
        model2Id: String(model2Id),
        foundModelIds: modelsResult.map(m => String(m.modelId)),
        model1Found: !!model1Config,
        model2Found: !!model2Config
      });
      return new Response(
        JSON.stringify({
          error: 'Model configuration error - found models but failed to match',
          details: {
            requested: [String(model1Id), String(model2Id)],
            found: modelsResult.map(m => String(m.modelId))
          }
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check if models are enabled for Nexus/Compare
    // Explicit !== true check handles null/undefined from older data
    if (model1Config.nexusEnabled !== true || model2Config.nexusEnabled !== true) {
      log.error('One or both models not enabled for Nexus/Compare', {
        model1Enabled: model1Config.nexusEnabled,
        model2Enabled: model2Config.nexusEnabled
      });
      return new Response(
        JSON.stringify({ error: 'One or both models not enabled for comparison' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 6. Detect image generation models
    const isModel1Image = hasCapability(model1Config.capabilities, 'imageGeneration');
    const isModel2Image = hasCapability(model2Config.capabilities, 'imageGeneration');

    log.info('Both models validated', sanitizeForLogging({
      model1: {
        provider: String(model1Config.provider),
        modelId: String(model1Config.modelId),
        isImageModel: isModel1Image
      },
      model2: {
        provider: String(model2Config.provider),
        modelId: String(model2Config.modelId),
        isImageModel: isModel2Image
      }
    }));

    // 7. Create comparison record for tracking
    const now = new Date();
    const comparisonResult = await executeQuery(
      (db) => db.insert(modelComparisons)
        .values({
          userId,
          prompt,
          model1Id: Number(model1Config.id),
          model2Id: Number(model2Config.id),
          model1Name: model1Name || String(model1Config.name),
          model2Name: model2Name || String(model2Config.name),
          metadata: {
            source: 'compare-streaming',
            requestId,
            sessionId: session.sub
          },
          createdAt: now,
          updatedAt: now
        })
        .returning({ id: modelComparisons.id }),
      'createComparisonRecord'
    );

    const comparisonId = Number(comparisonResult[0].id);

    log.info('Comparison record created', sanitizeForLogging({ comparisonId }));

    // 8. Create per-model response generators (text or image)
    const gen1 = isModel1Image
      ? createImageGenerator('model1', model1Config, prompt, String(userId), comparisonId, timerStartTime, log)
      : createTextGenerator('model1', model1Config, prompt, comparisonId, timerStartTime, log);

    const gen2 = isModel2Image
      ? createImageGenerator('model2', model2Config, prompt, String(userId), comparisonId, timerStartTime, log)
      : createTextGenerator('model2', model2Config, prompt, comparisonId, timerStartTime, log);

    // 9. Merge both generators into a single SSE stream
    const mergedGenerator = mergeResponseGenerators(gen1, gen2);
    const mergedStream = asyncGeneratorToStream(mergedGenerator);

    timer({
      status: 'success',
      comparisonId,
      operation: 'streaming_started'
    });

    // 10. Return SSE stream
    return new Response(mergedStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Request-Id': requestId,
        'X-Comparison-Id': comparisonId.toString()
      }
    });

  } catch (error) {
    log.error('Compare API error', {
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });

    timer({ status: 'error' });

    // Send only generic error message to client (full error logged above for server-side debugging)
    return new Response(
      JSON.stringify({
        error: 'Failed to process comparison request',
        message: 'An error occurred while processing your comparison request. Please try again.',
        requestId
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        }
      }
    );
  }
}
