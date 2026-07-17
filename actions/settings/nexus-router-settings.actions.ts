"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { executeTransaction } from "@/lib/db/drizzle-client"
import { settings } from "@/lib/db/schema"
import { getServerSession } from "@/lib/auth/server-session"
import { hasRole } from "@/lib/auth/role-helpers"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { createSuccess, ErrorFactories, handleError } from "@/lib/error-utils"
import { revalidateSettingsCache } from "@/lib/settings-manager"
import {
  NEXUS_ROUTER_CONFIG_KEY,
  NEXUS_ROUTER_MODE_KEY,
} from "@/lib/nexus/model-router/config"
import {
  nexusRouterConfigSchema,
  nexusRouterRuntimeModeSchema,
} from "@/lib/nexus/model-router/types"
import type { ActionState } from "@/types"

const inputSchema = z.object({
  mode: nexusRouterRuntimeModeSchema,
  config: nexusRouterConfigSchema,
})

export type NexusRouterSettingsInput = z.input<typeof inputSchema>

export async function updateNexusRouterSettings(
  input: NexusRouterSettingsInput
): Promise<ActionState<{ mode: string; config: string }>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateNexusRouterSettings")
  const log = createLogger({ requestId, action: "updateNexusRouterSettings" })

  try {
    const session = await getServerSession()
    if (!session) throw ErrorFactories.authNoSession()
    if (!(await hasRole("administrator"))) {
      throw ErrorFactories.authzAdminRequired("manage Nexus routing")
    }

    const parsed = inputSchema.parse(input)
    const serializedConfig = JSON.stringify(parsed.config)
    const now = new Date()

    await executeTransaction(async tx => {
      await tx.insert(settings).values({
        key: NEXUS_ROUTER_MODE_KEY,
        value: parsed.mode,
        description: "Nexus model router rollout mode: active, shadow, or off",
        category: "ai",
        isSecret: false,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: settings.key,
        set: {
          value: parsed.mode,
          description: "Nexus model router rollout mode: active, shadow, or off",
          category: "ai",
          isSecret: false,
          updatedAt: now,
        },
      })

      await tx.insert(settings).values({
        key: NEXUS_ROUTER_CONFIG_KEY,
        value: serializedConfig,
        description: "Nexus classifier, tier, family, image, instruction, and PSD-data routing configuration",
        category: "ai",
        isSecret: false,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: settings.key,
        set: {
          value: serializedConfig,
          description: "Nexus classifier, tier, family, image, instruction, and PSD-data routing configuration",
          category: "ai",
          isSecret: false,
          updatedAt: now,
        },
      })
    }, "updateNexusRouterSettings")

    await revalidateSettingsCache()
    revalidatePath("/admin/settings")
    timer({ status: "success" })
    log.info("Nexus router settings updated", { mode: parsed.mode })
    return createSuccess(
      { mode: parsed.mode, config: serializedConfig },
      "Nexus routing settings saved"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to save Nexus routing settings", {
      context: "updateNexusRouterSettings",
      requestId,
      operation: "updateNexusRouterSettings",
    })
  }
}
