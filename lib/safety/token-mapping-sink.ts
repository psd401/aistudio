import type { TokenMapping } from "./types";

/**
 * Request-scoped collection of reversible PII mappings.
 *
 * Tool results can introduce new privacy tokens after a provider stream has
 * already started. A mutable sink lets those tools publish mappings to the
 * response detokenizer without module-level state or cross-request leakage.
 */
export interface TokenMappingSink {
  add(mappings: readonly TokenMapping[]): void;
  resolve(placeholder: string): string | undefined;
  readonly size: number;
}

export function createTokenMappingSink(
  initialMappings: readonly TokenMapping[] = []
): TokenMappingSink {
  const mappingsByPlaceholder = new Map<string, TokenMapping>();

  const sink: TokenMappingSink = {
    add(mappings) {
      for (const mapping of mappings) {
        // A placeholder is immutable for the lifetime of a request. Keeping the
        // first value prevents a later tool call from changing text that may
        // already have been streamed to the user.
        if (!mappingsByPlaceholder.has(mapping.placeholder)) {
          mappingsByPlaceholder.set(mapping.placeholder, { ...mapping });
        }
      }
    },
    resolve(placeholder) {
      return mappingsByPlaceholder.get(placeholder)?.original;
    },
    get size() {
      return mappingsByPlaceholder.size;
    },
  };

  sink.add(initialMappings);
  return sink;
}
