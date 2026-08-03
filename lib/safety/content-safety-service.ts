/**
 * Guardrails-only content safety boundary for AI inputs and outputs.
 *
 * PII is not rewritten on inference paths. The two durable-content PII gates
 * use the separate detect-only service in `pii-detection-service.ts`.
 */

import { createLogger, generateRequestId } from "@/lib/logger";
import {
  BedrockGuardrailsService,
  getBedrockGuardrailsService,
} from "./bedrock-guardrails-service";
import type { GuardrailsConfig, SafetyCheckResult } from "./types";

export interface ContentSafetyResult extends SafetyCheckResult {
  requestId: string;
  processingTimeMs: number;
  /** Guardrails never rewrite allowed content. */
  contentModified: false;
}

export class ContentSafetyService {
  private readonly guardrailsService: BedrockGuardrailsService;
  private readonly log = createLogger({ module: "ContentSafetyService" });

  constructor(config?: Partial<GuardrailsConfig>) {
    this.guardrailsService = getBedrockGuardrailsService(config);
  }

  isEnabled(): boolean {
    return this.guardrailsService.isEnabled();
  }

  isGuardrailsEnabled(): boolean {
    return this.guardrailsService.isEnabled();
  }

  async processInput(
    content: string,
    sessionId: string,
  ): Promise<ContentSafetyResult> {
    const requestId = generateRequestId();
    const startTime = Date.now();
    this.log.info("Processing input content", {
      requestId,
      contentLength: content.length,
      sessionId,
      guardrailsEnabled: this.guardrailsService.isEnabled(),
    });

    try {
      if (this.guardrailsService.isEnabled()) {
        const safetyResult = await this.guardrailsService.evaluateInput(
          content,
          sessionId,
        );
        if (!safetyResult.allowed) {
          this.log.warn("Input blocked by guardrails", {
            requestId,
            reason: safetyResult.blockedReason,
            categories: safetyResult.blockedCategories,
          });
          return {
            ...safetyResult,
            requestId,
            processingTimeMs: Date.now() - startTime,
            contentModified: false,
          };
        }
      }

      return {
        allowed: true,
        processedContent: content,
        requestId,
        processingTimeMs: Date.now() - startTime,
        contentModified: false,
      };
    } catch (error) {
      this.log.error("Input processing failed", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        allowed: true,
        processedContent: content,
        requestId,
        processingTimeMs: Date.now() - startTime,
        contentModified: false,
      };
    }
  }

  async processOutput(
    content: string,
    modelId: string,
    provider: string,
    sessionId: string,
  ): Promise<ContentSafetyResult> {
    const requestId = generateRequestId();
    const startTime = Date.now();
    this.log.info("Processing output content", {
      requestId,
      contentLength: content.length,
      modelId,
      provider,
      sessionId,
      guardrailsEnabled: this.guardrailsService.isEnabled(),
    });

    try {
      if (this.guardrailsService.isEnabled()) {
        const safetyResult = await this.guardrailsService.evaluateOutput(
          content,
          modelId,
          provider,
          sessionId,
        );
        if (!safetyResult.allowed) {
          this.log.warn("Output blocked by guardrails", {
            requestId,
            reason: safetyResult.blockedReason,
            categories: safetyResult.blockedCategories,
            modelId,
            provider,
          });
          return {
            ...safetyResult,
            requestId,
            processingTimeMs: Date.now() - startTime,
            contentModified: false,
          };
        }
      }

      return {
        allowed: true,
        processedContent: content,
        requestId,
        processingTimeMs: Date.now() - startTime,
        contentModified: false,
      };
    } catch (error) {
      this.log.error("Output processing failed", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        allowed: true,
        processedContent: content,
        requestId,
        processingTimeMs: Date.now() - startTime,
        contentModified: false,
      };
    }
  }

  async checkInputSafety(
    content: string,
    sessionId?: string,
  ): Promise<SafetyCheckResult> {
    if (!this.guardrailsService.isEnabled()) {
      return { allowed: true, processedContent: content };
    }
    return this.guardrailsService.evaluateInput(content, sessionId);
  }

  async checkOutputSafety(
    content: string,
    modelId: string,
    provider: string,
    sessionId?: string,
  ): Promise<SafetyCheckResult> {
    if (!this.guardrailsService.isEnabled()) {
      return { allowed: true, processedContent: content };
    }
    return this.guardrailsService.evaluateOutput(
      content,
      modelId,
      provider,
      sessionId,
    );
  }

  getStatus(): {
    guardrailsEnabled: boolean;
    guardrailsConfig: ReturnType<BedrockGuardrailsService["getConfig"]>;
  } {
    return {
      guardrailsEnabled: this.guardrailsService.isEnabled(),
      guardrailsConfig: this.guardrailsService.getConfig(),
    };
  }
}

let contentSafetyServiceInstance: ContentSafetyService | null = null;

export function getContentSafetyService(
  config?: Partial<GuardrailsConfig>,
): ContentSafetyService {
  if (!contentSafetyServiceInstance) {
    contentSafetyServiceInstance = new ContentSafetyService(config);
  }
  return contentSafetyServiceInstance;
}

export function resetContentSafetyService(): void {
  contentSafetyServiceInstance = null;
}
