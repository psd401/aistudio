/**
 * SDK Compatibility Adapter
 *
 * Provides a compatibility layer for SSE events across different AI SDK versions.
 * Automatically normalizes events to the current expected format, handling field
 * renames and structural changes between versions.
 *
 * This prevents silent failures when the SDK is upgraded and event formats change.
 *
 * @see https://github.com/psd401/aistudio/issues/366
 * @see https://github.com/psd401/aistudio/issues/355 (Original bug)
 */

import { SDKVersionDetector, type SDKVersionInfo } from './sdk-version-detector';
import { createLogger } from '@/lib/logger';
import type { SSEEvent } from './sse-event-types';

const log = createLogger({ module: 'sdk-compatibility-adapter' });

/**
 * Field mapping for version compatibility
 * Maps old field names to new field names for each SDK version
 */
type FieldMapping = Map<string, string>;

/**
 * SSE Event Compatibility Adapter
 *
 * Normalizes SSE events to match the current expected format regardless of
 * which SDK version generated them. This allows the application to work
 * correctly even when the SDK version changes.
 *
 * @example
 * ```typescript
 * const adapter = new SSEEventAdapter();
 *
 * // Parse and normalize an event
 * const rawEvent = JSON.parse(sseData);
 * const normalized = adapter.normalizeEvent(rawEvent);
 *
 * // Validate event structure
 * const validation = adapter.validateEventStructure(normalized);
 * if (!validation.valid) {
 *   console.error('Invalid event:', validation.issues);
 * }
 * ```
 */
export class SSEEventAdapter {
  private version: SDKVersionInfo;
  private fieldMappings = new Map<string, FieldMapping>();

  constructor() {
    this.version = SDKVersionDetector.detect();
    this.initializeMappings();

    log.info('SSE Event Adapter initialized', {
      sdkVersion: this.version.version,
      detectionMethod: this.version.detected,
      hasMappings: this.fieldMappings.size > 0,
    });

    // Warn about fallback detection in development
    if (
      this.version.detected === 'fallback' &&
      typeof process !== 'undefined' &&
      process.env.NODE_ENV === 'development'
    ) {
      log.warn('SDK version detection used fallback - compatibility may be limited');
    }

    // Warn about prerelease versions
    if (this.version.prerelease) {
      log.warn('Using prerelease SDK version - behavior may be unstable', {
        version: this.version.version,
        prerelease: this.version.prerelease,
      });
    }
  }

  /**
   * Initialize field mappings for different SDK versions
   *
   * Add new mappings here when the SDK changes field names or event structures.
   */
  private initializeMappings(): void {
    // v4 -> v5 field mappings (if needed in the future for backward compatibility)
    if (this.version.major === 4) {
      const v4Mappings = new Map<string, string>([
        ['textDelta', 'delta'], // v4 used 'textDelta', v5 uses 'delta'
      ]);
      this.fieldMappings.set('4', v4Mappings);

      log.debug('Loaded v4 compatibility mappings', {
        mappingCount: v4Mappings.size,
      });
    }

    // v5 is the current version - no mappings needed
    if (this.version.major === 5) {
      // No mappings needed for current version
      log.debug('v5 detected - no compatibility mappings needed');
    }

    // v6 placeholder for future versions
    if (this.version.major >= 6) {
      const v6Mappings = new Map<string, string>();
      // Add mappings when v6 is released and we know what changed
      // Example:
      // v6Mappings.set('oldFieldName', 'newFieldName');

      this.fieldMappings.set('6', v6Mappings);

      log.warn('SDK v6+ detected - compatibility mappings may be incomplete', {
        version: this.version.version,
      });
    }
  }

  /**
   * Normalize an SSE event to the current expected format
   *
   * Applies field mappings and structural transformations to ensure
   * compatibility across SDK versions.
   *
   * @param event - Raw event object from SSE stream
   * @returns Normalized event matching current type definitions
   *
   * @example
   * ```typescript
   * // v4 event: { type: 'text-delta', textDelta: 'Hello' }
   * // Normalized: { type: 'text-delta', delta: 'Hello' }
   * const normalized = adapter.normalizeEvent(rawEvent);
   * ```
   */
  normalizeEvent(event: unknown): SSEEvent {
    if (!event || typeof event !== 'object') {
      log.error('Invalid event object passed to normalizeEvent', { event });
      throw new Error('Event must be a non-null object');
    }

    const normalized = { ...event } as Record<string, unknown>;
    const versionKey = String(this.version.major);
    const mappings = this.fieldMappings.get(versionKey);

    if (!mappings || mappings.size === 0) {
      // No mappings needed for this version - return as-is
      return normalized as unknown as SSEEvent;
    }

    // Apply field mappings
    for (const [oldField, newField] of mappings.entries()) {
      if (oldField in normalized && !(newField in normalized)) {
        const value = normalized[oldField];
        // Only map non-null, non-undefined values
        if (value !== null && value !== undefined) {
          normalized[newField] = value;
          delete normalized[oldField];

          log.debug('Applied field mapping', {
            type: normalized.type,
            oldField,
            newField,
            version: this.version.version,
          });
        }
      }
    }

    // Type-specific normalization for known issues
    if (normalized.type === 'text-delta') {
      // Ensure 'delta' field exists (handle both v4 and v5 formats)
      if (!('delta' in normalized)) {
        if ('textDelta' in normalized) {
          normalized.delta = normalized.textDelta;
          delete normalized.textDelta;

          log.debug('Normalized text-delta event (textDelta → delta)', {
            version: this.version.version,
          });
        } else {
          log.warn('text-delta event missing both delta and textDelta fields', {
            event: normalized,
          });
        }
      }
    }

    return normalized as unknown as SSEEvent;
  }

  /**
   * Validate event structure against expected format
   *
   * Checks that the event has required fields and correct types for the
   * current SDK version.
   *
   * @param event - Event object to validate
   * @returns Validation result with issues list
   *
   * @example
   * ```typescript
   * const validation = adapter.validateEventStructure(event);
   * if (!validation.valid) {
   *   console.error('Validation errors:', validation.issues);
   * }
   * ```
   */
  validateEventStructure(event: unknown): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Basic validation
    if (!event || typeof event !== 'object') {
      issues.push('Event must be a non-null object');
      return { valid: false, issues };
    }

    const evt = event as Record<string, unknown>;

    if (!evt.type || typeof evt.type !== 'string') {
      issues.push('Event must have a string "type" field');
      return { valid: false, issues };
    }

    // Type-specific validation based on SDK version
    const eventType = evt.type;

    // Validate text-delta events
    if (eventType === 'text-delta') {
      const expectedField = this.version.major >= 5 ? 'delta' : 'textDelta';

      if (!(expectedField in evt)) {
        issues.push(
          `text-delta event missing "${expectedField}" field for SDK v${this.version.major}`
        );
      }

      if (expectedField in evt && typeof evt[expectedField] !== 'string') {
        issues.push(`text-delta "${expectedField}" field must be a string`);
      }
    }

    // Validate reasoning-delta events
    if (eventType === 'reasoning-delta') {
      if (!('delta' in evt)) {
        issues.push('reasoning-delta event missing "delta" field');
      }

      if ('delta' in evt && typeof evt.delta !== 'string') {
        issues.push('reasoning-delta "delta" field must be a string');
      }
    }

    // Validate tool events
    if (eventType.startsWith('tool-')) {
      if (!('toolCallId' in evt)) {
        issues.push(`${eventType} event missing "toolCallId" field`);
      }

      if (
        eventType !== 'tool-output-error' &&
        eventType !== 'tool-output-available' &&
        !('toolName' in evt)
      ) {
        issues.push(`${eventType} event missing "toolName" field`);
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * Parse and normalize an SSE event from raw data string
   *
   * Combines JSON parsing with normalization in a single step.
   *
   * @param data - Raw SSE data string (JSON format)
   * @returns Normalized SSE event
   * @throws Error if parsing fails
   *
   * @example
   * ```typescript
   * const event = adapter.parseAndNormalize('{"type":"text-delta","delta":"Hi"}');
   * ```
   */
  parseAndNormalize(data: string): SSEEvent {
    try {
      const raw = JSON.parse(data);
      return this.normalizeEvent(raw);
    } catch (error) {
      if (error instanceof SyntaxError) {
        log.error('Failed to parse SSE event JSON', {
          error: error.message,
          data: data.substring(0, 100), // Log first 100 chars
        });
        throw new Error(`Failed to parse SSE event JSON: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Get current SDK version information
   *
   * @returns Version info object
   */
  getVersion(): SDKVersionInfo {
    return this.version;
  }

  /**
   * Check if a specific SDK version is in use
   *
   * @param major - Major version to check
   * @param minor - Optional minor version to check
   * @returns True if the current SDK matches the specified version
   */
  isVersion(major: number, minor?: number): boolean {
    return SDKVersionDetector.isCompatible(major, minor);
  }
}

/**
 * Singleton instance for convenience
 *
 * Use this for simple cases where you don't need to manage the adapter lifecycle.
 *
 * @example
 * ```typescript
 * import { sseAdapter } from './sdk-compatibility-adapter';
 *
 * const normalized = sseAdapter.normalizeEvent(rawEvent);
 * ```
 */
export const sseAdapter = new SSEEventAdapter();
