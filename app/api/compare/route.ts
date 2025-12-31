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
import { mergeStreamsWithIdentifiers, asyncGeneratorToStream } from '@/lib/compare/dual-stream-merger';

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

/**
 * Compare Models API - Native Dual Streaming
 * Streams responses from two models in parallel using Server-Sent Events
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
        nexusEnabled: aiModels.nexusEnabled
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
    if (!model1Config.nexusEnabled || !model2Config.nexusEnabled) {
      log.error('One or both models not enabled for Nexus/Compare', {
        model1Enabled: model1Config.nexusEnabled,
        model2Enabled: model2Config.nexusEnabled
      });
      return new Response(
        JSON.stringify({ error: 'One or both models not enabled for comparison' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    log.info('Both models validated', sanitizeForLogging({
      model1: {
        provider: String(model1Config.provider),
        modelId: String(model1Config.modelId)
      },
      model2: {
        provider: String(model2Config.provider),
        modelId: String(model2Config.modelId)
      }
    }));

    // 6. Create comparison record for tracking
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

    // 7. Create provider models for streaming
    const model1 = await createProviderModel(
      String(model1Config.provider),
      String(model1Config.modelId)
    );

    const model2 = await createProviderModel(
      String(model2Config.provider),
      String(model2Config.modelId)
    );

    log.info('Provider models created', {
      model1Provider: String(model1Config.provider),
      model2Provider: String(model2Config.provider)
    });

    // 8. Create streaming responses for both models
    const stream1Promise = streamText({
      model: model1,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      onFinish: async ({ text, usage, finishReason }) => {
        // Save Model 1 response
        try {
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

          log.info('Model 1 response saved', {
            comparisonId,
            textLength: text.length,
            usage,
            finishReason
          });
        } catch (error) {
          log.error('Failed to save Model 1 response', {
            comparisonId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    const stream2Promise = streamText({
      model: model2,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      onFinish: async ({ text, usage, finishReason }) => {
        // Save Model 2 response
        try {
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

          log.info('Model 2 response saved', {
            comparisonId,
            textLength: text.length,
            usage,
            finishReason
          });
        } catch (error) {
          log.error('Failed to save Model 2 response', {
            comparisonId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    // 9. Merge both streams with model identification
    // StreamTextResult is both a Promise and has async iterable properties
    const mergedGenerator = mergeStreamsWithIdentifiers(
      stream1Promise,
      stream2Promise
    );

    // Convert AsyncGenerator to ReadableStream
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
