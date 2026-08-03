/**
 * Detect-only PII service for the two durable-content safety gates.
 *
 * Ordinary AI requests run under zero-data-retention agreements and do not
 * rewrite user content. Nexus memory writes use this service as a fail-closed
 * refusal gate; published agent content uses it for non-blocking telemetry.
 */

import {
  ComprehendClient,
  DetectPiiEntitiesCommand,
} from "@aws-sdk/client-comprehend";
import type { PiiEntity as ComprehendPiiEntity } from "@aws-sdk/client-comprehend";
import { createLogger, generateRequestId } from "@/lib/logger";
import type { GuardrailsConfig, PIIEntity } from "./types";
import {
  CONFIDENCE_GATED_PII_TYPES,
  CUSTOM_PII_PATTERNS,
  K12_PII_TYPES,
  PII_MIN_CONFIDENCE_SCORE,
  PII_TYPE_CONFIDENCE_OVERRIDES,
  type ComprehendPIIType,
} from "./types";

export class PIIDetectionUnavailableError extends Error {
  constructor() {
    super("PII detection is not configured");
    this.name = "PIIDetectionUnavailableError";
  }
}

function relevantComprehendEntity(entity: PIIEntity): boolean {
  const type = entity.type as ComprehendPIIType;
  if (!K12_PII_TYPES.includes(type)) return false;
  if (!CONFIDENCE_GATED_PII_TYPES.has(type)) return true;
  const floor =
    PII_TYPE_CONFIDENCE_OVERRIDES[type] ?? PII_MIN_CONFIDENCE_SCORE;
  return entity.score >= floor;
}

function mergeEntities(
  comprehendEntities: readonly PIIEntity[],
  customEntities: readonly PIIEntity[],
): PIIEntity[] {
  return [
    ...customEntities,
    ...comprehendEntities.filter(
      (comprehend) =>
        !customEntities.some(
          (custom) =>
            comprehend.beginOffset < custom.endOffset &&
            comprehend.endOffset > custom.beginOffset,
        ),
    ),
  ];
}

export class PIIDetectionService {
  private readonly comprehendClient: ComprehendClient;
  private readonly region: string;
  private readonly log = createLogger({ module: "PIIDetectionService" });

  constructor(config?: Partial<GuardrailsConfig>) {
    this.region = config?.region || process.env.AWS_REGION || "";
    this.comprehendClient = new ComprehendClient({
      region: this.region || "us-east-1",
    });
    if (!this.region) {
      this.log.warn(
        "AWS_REGION not configured - PII detection unavailable (local development mode)",
      );
    }
  }

  isEnabled(): boolean {
    return this.region.length > 0;
  }

  async detectPII(text: string): Promise<PIIEntity[]> {
    if (!this.isEnabled()) {
      throw new PIIDetectionUnavailableError();
    }

    const requestId = generateRequestId();
    try {
      const response = await this.comprehendClient.send(
        new DetectPiiEntitiesCommand({ Text: text, LanguageCode: "en" }),
      );
      const comprehendEntities = (response.Entities || [])
        .filter(
          (entity: ComprehendPiiEntity): boolean =>
            entity.Type !== undefined &&
            entity.BeginOffset !== undefined &&
            entity.EndOffset !== undefined &&
            entity.Score !== undefined,
        )
        .map((entity: ComprehendPiiEntity): PIIEntity => ({
          type: entity.Type as string,
          beginOffset: entity.BeginOffset as number,
          endOffset: entity.EndOffset as number,
          score: entity.Score as number,
        }))
        .filter(relevantComprehendEntity);
      const entities = mergeEntities(
        comprehendEntities,
        this.detectCustomPII(text),
      );
      this.log.debug("PII detection complete", {
        requestId,
        textLength: text.length,
        entitiesFound: entities.length,
        entityTypes: entities.map((entity) => entity.type),
      });
      return entities;
    } catch (error) {
      this.log.error("PII detection failed", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  detectCustomPII(text: string): PIIEntity[] {
    const entities: PIIEntity[] = [];
    for (const pattern of CUSTOM_PII_PATTERNS) {
      let offset = 0;
      while (offset <= text.length) {
        pattern.pattern.lastIndex = 0;
        const match = pattern.pattern.exec(text.slice(offset));
        if (!match) break;
        const beginOffset = offset + match.index;
        entities.push({
          type: pattern.type,
          beginOffset,
          endOffset: beginOffset + match[0].length,
          score: pattern.confidence ?? 1,
        });
        offset = beginOffset + Math.max(match[0].length, 1);
      }
    }
    return entities;
  }

  getConfig(): Pick<GuardrailsConfig, "region"> {
    return { region: this.region };
  }
}

let piiDetectionServiceInstance: PIIDetectionService | null = null;

export function getPIIDetectionService(
  config?: Partial<GuardrailsConfig>,
): PIIDetectionService {
  if (!piiDetectionServiceInstance) {
    piiDetectionServiceInstance = new PIIDetectionService(config);
  }
  return piiDetectionServiceInstance;
}

export function resetPIIDetectionService(): void {
  piiDetectionServiceInstance = null;
}
