import { getAIModelById, getAIModelByModelId } from '@/lib/db/drizzle';
import { createLogger } from '@/lib/logger';

const log = createLogger({ module: 'model-config' });

/**
 * Get model configuration from database
 */
export async function getModelConfig(modelId: string | number) {
  log.info('getModelConfig called', { modelId, type: typeof modelId });

  const isNumericId = typeof modelId === 'number' || /^\d+$/.test(String(modelId));

  const model = isNumericId
    ? await getAIModelById(Number(modelId))
    : await getAIModelByModelId(String(modelId));

  if (!model || !model.active || !model.chatEnabled) {
    log.error('Model not found or not enabled for chat', { modelId, found: !!model });
    return null;
  }

  log.info('Model found in database', {
    id: model.id,
    name: model.name,
    provider: model.provider,
    modelId: model.modelId
  });

  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    model_id: model.modelId
  };
}
