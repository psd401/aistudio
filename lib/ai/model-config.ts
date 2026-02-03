import { getAIModelById, getAIModelByModelId } from '@/lib/db/drizzle';
import { createLogger } from '@/lib/logger';

const log = createLogger({ module: 'model-config' });

/**
 * Get model configuration from database
 * Used by: Nexus chat, Model Compare
 * Validates that model is active AND nexusEnabled
 */
export async function getModelConfig(modelId: string | number) {
  log.info('getModelConfig called', { modelId, type: typeof modelId });

  const isNumericId = typeof modelId === 'number' || /^\d+$/.test(String(modelId));

  const model = isNumericId
    ? await getAIModelById(Number(modelId))
    : await getAIModelByModelId(String(modelId));

  if (!model || !model.active || !model.nexusEnabled) {
    log.error('Model not found or not enabled for Nexus', { modelId, found: !!model });
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
