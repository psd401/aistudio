import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from '@/lib/auth/server-session'
import { getModelCapabilities } from '@/lib/tools/tool-registry'
import { createLogger, generateRequestId } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
) {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, route: 'api.models.capabilities' })
  
  try {
    // Check authentication
    const session = await getServerSession()
    if (!session) {
      log.warn('Unauthorized request')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const resolvedParams = await params
    const modelId = decodeURIComponent(resolvedParams.modelId)
    
    // Validate modelId format to prevent injection attacks
    if (!modelId || typeof modelId !== 'string' || !/^[\w.-]+$/.test(modelId)) {
      log.warn('Invalid modelId format', { modelId })
      return NextResponse.json({ error: 'Invalid model ID format' }, { status: 400 })
    }
    
    log.info('Getting model capabilities', { modelId })
    
    // Get model capabilities from the server-side registry
    const capabilities = await getModelCapabilities(modelId)
    
    if (!capabilities) {
      log.warn('Model not found or no capabilities available', { modelId })
      return NextResponse.json({ error: 'Model not found or no capabilities available' }, { status: 404 })
    }

    log.info('Successfully retrieved model capabilities', { modelId })
    return NextResponse.json(capabilities)
  } catch (error) {
    log.error('Failed to get model capabilities', { error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}