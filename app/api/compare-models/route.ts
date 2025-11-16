import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { unifiedStreamingService } from '@/lib/streaming/unified-streaming-service';
import { getModelConfig } from '@/lib/ai/model-config';
import type { StreamRequest } from '@/lib/streaming/types';
import { UIMessage } from 'ai';

// Allow streaming responses up to 30 seconds for each model
export const maxDuration = 30;

/**
 * Compare Models API endpoint using unified streaming service
 * Handles dual-model comparisons with parallel streaming
 */
export async function POST(req: Request) {
  const requestId = generateRequestId();
  const timer = startTimer('api.compare-models');
  const log = createLogger({ requestId, route: 'api.compare-models' });
  
  log.info('POST /api/compare-models - Processing comparison request');
  
  try {
    // 1. Parse and validate request
    const body = await req.json();
    const { prompt, model1Id, model2Id, model1Name, model2Name } = body;
    
    // Validate prompt
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      log.warn('Invalid prompt', { promptType: typeof prompt, promptLength: typeof prompt === 'string' ? prompt.length : 0 });
      return new Response(JSON.stringify({ error: 'Invalid prompt' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Add prompt length limit
    const MAX_PROMPT_LENGTH = 10000;
    if (prompt.length > MAX_PROMPT_LENGTH) {
      log.warn('Prompt too long', { promptLength: prompt.length, maxLength: MAX_PROMPT_LENGTH });
      return new Response(JSON.stringify({ error: 'Prompt too long' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate model IDs are valid strings/numbers
    const isValidModelId = (id: unknown): id is string | number => {
      return (typeof id === 'string' && id.trim().length > 0) || 
             (typeof id === 'number' && !Number.isNaN(id) && id > 0);
    };

    if (!isValidModelId(model1Id) || !isValidModelId(model2Id)) {
      log.warn('Invalid model IDs', { 
        model1Id: typeof model1Id === 'string' ? model1Id.substring(0, 50) : model1Id,
        model2Id: typeof model2Id === 'string' ? model2Id.substring(0, 50) : model2Id
      });
      return new Response(JSON.stringify({ error: 'Invalid model ID' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate optional model names if provided
    if (model1Name && typeof model1Name !== 'string') {
      log.warn('Invalid model1Name type', { type: typeof model1Name });
      return new Response(JSON.stringify({ error: 'Invalid model name' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (model2Name && typeof model2Name !== 'string') {
      log.warn('Invalid model2Name type', { type: typeof model2Name });
      return new Response(JSON.stringify({ error: 'Invalid model name' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    log.debug('Request parsed', {
      model1Id,
      model2Id,
      model1Name,
      model2Name,
      promptLength: prompt.length
    });
    
    // 2. Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request - no session');
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response('Unauthorized', { status: 401 });
    }
    
    // 3. Get current user
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user');
      return new Response('Unauthorized', { status: 401 });
    }
    
    // 4. Get model configurations
    const [model1Config, model2Config] = await Promise.all([
      getModelConfig(model1Id),
      getModelConfig(model2Id)
    ]);
    
    if (!model1Config || !model2Config) {
      log.error('One or both models not found', { 
        model1Found: !!model1Config, 
        model2Found: !!model2Config 
      });
      return new Response(
        JSON.stringify({ error: 'One or both models not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    log.info('Models configured', {
      model1: { provider: model1Config.provider, modelId: model1Config.model_id },
      model2: { provider: model2Config.provider, modelId: model2Config.model_id }
    });
    
    // 5. Create messages for both models
    const messages: UIMessage[] = [
      {
        id: generateRequestId(),
        role: 'user',
        parts: [{ type: 'text', text: prompt }]
      }
    ];
    
    // 6. Create SSE response stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Helper to send SSE data
          const sendData = (data: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          };
          
          // Track completion status
          let model1Complete = false;
          let model2Complete = false;
          
          // Create stream requests for both models
          const streamRequest1: StreamRequest = {
            messages,
            modelId: model1Config.model_id,
            provider: model1Config.provider,
            userId: currentUser.data.user.id.toString(),
            sessionId: session.sub,
            source: 'compare',
            systemPrompt: `You are a helpful AI assistant. Please provide a clear and concise response.`,
            callbacks: {
              onProgress: (event) => {
                // Stream model1 chunks
                if (event.type === 'token' && event.text) {
                  sendData({ model1: event.text });
                }
              },
              onFinish: async ({ usage }) => {
                log.info('Model 1 completed', {
                  modelId: model1Config.model_id,
                  tokensUsed: usage?.totalTokens
                });
                sendData({ model1Finished: true });
                model1Complete = true;
                
                // Check if both models are complete
                if (model1Complete && model2Complete) {
                  sendData({ done: true });
                  controller.close();
                }
              },
              onError: (error) => {
                log.error('Model 1 error', { error: error.message });
                sendData({ model1Error: error.message });
                model1Complete = true;
                
                if (model1Complete && model2Complete) {
                  sendData({ done: true });
                  controller.close();
                }
              }
            }
          };
          
          const streamRequest2: StreamRequest = {
            messages,
            modelId: model2Config.model_id,
            provider: model2Config.provider,
            userId: currentUser.data.user.id.toString(),
            sessionId: session.sub,
            source: 'compare',
            systemPrompt: `You are a helpful AI assistant. Please provide a clear and concise response.`,
            callbacks: {
              onProgress: (event) => {
                // Stream model2 chunks
                if (event.type === 'token' && event.text) {
                  sendData({ model2: event.text });
                }
              },
              onFinish: async ({ usage }) => {
                log.info('Model 2 completed', {
                  modelId: model2Config.model_id,
                  tokensUsed: usage?.totalTokens
                });
                sendData({ model2Finished: true });
                model2Complete = true;
                
                // Check if both models are complete
                if (model1Complete && model2Complete) {
                  sendData({ done: true });
                  controller.close();
                }
              },
              onError: (error) => {
                log.error('Model 2 error', { error: error.message });
                sendData({ model2Error: error.message });
                model2Complete = true;
                
                if (model1Complete && model2Complete) {
                  sendData({ done: true });
                  controller.close();
                }
              }
            }
          };
          
          // 7. Execute both streams in parallel using unified service
          log.info('Starting parallel streams');
          
          await Promise.all([
            unifiedStreamingService.stream(streamRequest1).catch(error => {
              log.error('Failed to stream model 1', { error });
              sendData({ model1Error: 'Failed to stream response' });
              model1Complete = true;
            }),
            unifiedStreamingService.stream(streamRequest2).catch(error => {
              log.error('Failed to stream model 2', { error });
              sendData({ model2Error: 'Failed to stream response' });
              model2Complete = true;
            })
          ]);
          
          timer({ status: 'success' });
          
        } catch (error) {
          log.error('Stream error', { error });
          controller.error(error);
          timer({ status: 'error' });
        }
      }
    });
    
    // Return SSE response
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-Id': requestId,
        'X-Unified-Streaming': 'true'
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
    
    return new Response(
      JSON.stringify({
        error: 'Failed to process comparison request',
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