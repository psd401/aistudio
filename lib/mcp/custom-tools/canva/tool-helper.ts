/**
 * Helper to create AI SDK tools with proper typing.
 *
 * AI SDK v6's `tool()` function has 4 overloads that don't resolve correctly
 * when `execute` is provided without an `outputSchema`. This wrapper casts
 * through `unknown` to produce the correct runtime shape while satisfying
 * TypeScript's strict mode. The same pattern is used in repository-tools.ts.
 *
 * @see lib/tools/repository-tools.ts for precedent
 */

import { tool as sdkTool } from "ai"
import type { z } from "zod"

interface ToolConfig<S extends z.ZodType> {
  description: string
  parameters: S
  execute: (args: z.infer<S>) => Promise<unknown>
}

/** Creates an AI SDK tool, working around v6 overload inference issues */
export function canvaTool<S extends z.ZodType>(config: ToolConfig<S>): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sdkTool(config as any)
}
