import { createLogger } from '@/lib/logger';
import { Settings } from '@/lib/settings-manager';
import type { TelemetrySpan, TelemetryConfig } from './types';

// OpenTelemetry types
interface OTelTracer {
  startSpan: (name: string, options?: Record<string, unknown>) => TelemetrySpan;
}

interface OTelMeter {
  createCounter: (name: string, options?: { description?: string }) => {
    add: (value: number, attributes?: Record<string, string | number>) => void;
  };
  createHistogram: (name: string, options?: { description?: string }) => {
    record: (value: number, attributes?: Record<string, string | number>) => void;
  };
}

// OpenTelemetry imports are optional - fail gracefully if not installed
let trace: { getTracer: (name: string, version: string) => OTelTracer };
let metrics: { getMeter: (name: string, version: string) => OTelMeter };

// Initialize with no-op implementations
trace = {
  getTracer: () => ({
    startSpan: () => ({
      setAttributes: () => {},
      addEvent: () => {},
      recordException: () => {},
      setStatus: () => {},
      end: () => {}
    })
  })
};
metrics = {
  getMeter: () => ({
    createCounter: () => ({ add: () => {} }),
    createHistogram: () => ({ record: () => {} })
  })
};

// Try to load OpenTelemetry if available
if (typeof window === 'undefined') { // Only on server side
  try {
    // Dynamic import for optional OpenTelemetry dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const otelApi = require('@opentelemetry/api');
    trace = otelApi.trace;
    metrics = otelApi.metrics;
  } catch {
    // OpenTelemetry not installed - use no-op implementations
  }
}

const log = createLogger({ module: 'telemetry-service' });

export interface AITelemetryRequest {
  functionId: string;
  userId?: string;
  sessionId?: string;
  conversationId?: string | number;
  modelId: string;
  provider: string;
  source: 'chat' | 'compare' | 'assistant_execution' | 'ai-helpers' | 'nexus';
  recordInputs?: boolean;
  recordOutputs?: boolean;
  customAttributes?: Record<string, string | number | boolean>;
}

/**
 * Get telemetry configuration for AI operations
 * Follows OpenTelemetry semantic conventions for AI/ML workloads
 */
export async function getTelemetryConfig(request: AITelemetryRequest): Promise<TelemetryConfig> {
  try {
    // Check if telemetry is enabled
    const telemetryEnabled = process.env.TELEMETRY_ENABLED === 'true';
    
    if (!telemetryEnabled) {
      return {
        isEnabled: false,
        functionId: request.functionId,
        metadata: {},
        recordInputs: false,
        recordOutputs: false
      };
    }
    
    // Get telemetry settings from database/env
    const settings = await getTelemetrySettings();
    
    if (!settings.enabled) {
      return {
        isEnabled: false,
        functionId: request.functionId,
        metadata: {},
        recordInputs: false,
        recordOutputs: false
      };
    }
    
    // Create tracer if available
    const tracer = trace.getTracer('aistudio.ai', '1.0.0');
    
    // Build metadata following OpenTelemetry semantic conventions
    const metadata = {
      // Service attributes
      'service.name': 'aistudio',
      'service.version': process.env.APP_VERSION || '1.0.0',
      'service.environment': process.env.NODE_ENV || 'development',
      
      // AI/ML specific attributes
      'ai.model.id': request.modelId,
      'ai.model.provider': request.provider,
      'ai.request.source': request.source,
      'ai.operation.name': request.functionId,
      
      // User context (if available and privacy allows)
      ...(settings.recordUserContext && request.userId && {
        'user.id': request.userId
      }),
      ...(request.sessionId && {
        'ai.session.id': request.sessionId
      }),
      ...(request.conversationId && {
        'ai.conversation.id': String(request.conversationId)
      }),
      
      // Custom attributes
      ...request.customAttributes,
      
      // Timestamps
      'ai.request.timestamp': Date.now(),
      'ai.request.timezone': Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    
    return {
      isEnabled: true,
      functionId: request.functionId,
      metadata,
      recordInputs: settings.recordInputs ?? request.recordInputs ?? true,
      recordOutputs: settings.recordOutputs ?? request.recordOutputs ?? true,
      tracer
    };
    
  } catch (error) {
    log.error('Failed to get telemetry config', { 
      error: error instanceof Error ? error.message : String(error),
      functionId: request.functionId
    });
    
    // Return disabled config on error to avoid breaking AI operations
    return {
      isEnabled: false,
      functionId: request.functionId,
      metadata: {},
      recordInputs: false,
      recordOutputs: false
    };
  }
}

/**
 * Initialize OpenTelemetry instrumentation
 * Call this once at application startup
 */
export async function initializeTelemetry(): Promise<void> {
  const telemetryEnabled = process.env.TELEMETRY_ENABLED === 'true';
  
  if (!telemetryEnabled) {
    log.info('Telemetry disabled via environment variable');
    return;
  }
  
  try {
    const settings = await getTelemetrySettings();
    
    if (!settings.enabled || !settings.endpoint) {
      log.info('Telemetry disabled in settings or no endpoint configured');
      return;
    }
    
    // Note: OpenTelemetry dependencies not installed - placeholder implementation
    log.info('OpenTelemetry packages not available, telemetry disabled');
    return;
    
  } catch (error) {
    log.error('Failed to initialize OpenTelemetry', {
      error: error instanceof Error ? error.message : String(error)
    });
    // Don't throw - telemetry failures shouldn't break the app
  }
}

/**
 * Get telemetry settings from database with environment variable fallbacks
 */
async function getTelemetrySettings() {
  try {
    // Try to get settings from database first (if method exists)
    // Type assertion for Settings method that may not exist
    const settingsWithTelemetry = Settings as typeof Settings & {
      getTelemetry?: () => Promise<{
        enabled: boolean;
        endpoint?: string;
        headers?: Record<string, string>;
        serviceName?: string;
        serviceVersion?: string;
        recordInputs?: boolean;
        recordOutputs?: boolean;
        recordUserContext?: boolean;
        samplingRate?: number;
      }>;
    };
    const dbSettings = settingsWithTelemetry.getTelemetry ? await settingsWithTelemetry.getTelemetry() : null;
    
    if (dbSettings) {
      return dbSettings;
    }
  } catch {
    log.debug('Could not load telemetry settings from database, using environment variables');
  }
  
  // Fallback to environment variables
  return {
    enabled: process.env.TELEMETRY_ENABLED === 'true',
    endpoint: process.env.TELEMETRY_ENDPOINT,
    headers: process.env.TELEMETRY_HEADERS ? 
      JSON.parse(process.env.TELEMETRY_HEADERS) : 
      undefined,
    serviceName: process.env.TELEMETRY_SERVICE_NAME || 'aistudio',
    serviceVersion: process.env.TELEMETRY_SERVICE_VERSION || '1.0.0',
    recordInputs: process.env.TELEMETRY_RECORD_INPUTS !== 'false', // Default true
    recordOutputs: process.env.TELEMETRY_RECORD_OUTPUTS !== 'false', // Default true
    recordUserContext: process.env.TELEMETRY_RECORD_USER_CONTEXT === 'true', // Default false
    samplingRate: Number.parseFloat(process.env.TELEMETRY_SAMPLING_RATE || '1.0')
  };
}

/**
 * Record custom metrics for AI operations
 */
export function recordAIMetrics(data: {
  provider: string;
  modelId: string;
  source: string;
  tokensInput?: number;
  tokensOutput?: number;
  tokensReasoning?: number;
  cost?: number;
  latencyMs?: number;
  status: 'success' | 'error' | 'timeout';
  errorType?: string;
}) {
  try {
    const meter = metrics.getMeter('aistudio.ai', '1.0.0');
    
    // Token usage counters
    if (data.tokensInput) {
      meter.createCounter('ai.tokens.input', {
        description: 'Input tokens used by AI models'
      }).add(data.tokensInput, {
        provider: data.provider,
        model: data.modelId,
        source: data.source
      });
    }
    
    if (data.tokensOutput) {
      meter.createCounter('ai.tokens.output', {
        description: 'Output tokens generated by AI models'
      }).add(data.tokensOutput, {
        provider: data.provider,
        model: data.modelId,
        source: data.source
      });
    }
    
    if (data.tokensReasoning) {
      meter.createCounter('ai.tokens.reasoning', {
        description: 'Reasoning tokens used by advanced AI models'
      }).add(data.tokensReasoning, {
        provider: data.provider,
        model: data.modelId,
        source: data.source
      });
    }
    
    // Cost tracking
    if (data.cost) {
      meter.createCounter('ai.cost.total', {
        description: 'Total cost of AI operations'
      }).add(data.cost, {
        provider: data.provider,
        model: data.modelId,
        source: data.source
      });
    }
    
    // Latency histogram
    if (data.latencyMs) {
      meter.createHistogram('ai.request.duration', {
        description: 'AI request duration in milliseconds'
      }).record(data.latencyMs, {
        provider: data.provider,
        model: data.modelId,
        source: data.source,
        status: data.status
      });
    }
    
    // Error tracking
    if (data.status === 'error') {
      meter.createCounter('ai.errors.total', {
        description: 'Total AI operation errors'
      }).add(1, {
        provider: data.provider,
        model: data.modelId,
        source: data.source,
        error_type: data.errorType || 'unknown'
      });
    }
    
    // Success rate
    meter.createCounter('ai.requests.total', {
      description: 'Total AI requests'
    }).add(1, {
      provider: data.provider,
      model: data.modelId,
      source: data.source,
      status: data.status
    });
    
  } catch (error) {
    log.error('Failed to record AI metrics', {
      error: error instanceof Error ? error.message : String(error),
      data
    });
    // Don't throw - metrics failures shouldn't break AI operations
  }
}