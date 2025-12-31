"use server"

import { getAIModels, getArchitectEnabledModels } from "@/lib/db/drizzle"
import { ActionState, SelectAiModel } from "@/types"
import { getServerSession } from "@/lib/auth/server-session"
import {
  handleError,
  ErrorFactories,
  createSuccess
} from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer
} from "@/lib/logger"

/**
 * Get all AI models (for admin pages)
 */
export async function getAiModelsAction(): Promise<ActionState<SelectAiModel[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAiModels")
  const log = createLogger({ requestId, action: "getAiModels" })

  try {
    log.info("Action started: Getting AI models")

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized AI models access attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("User authenticated", { userId: session.sub })

    log.debug("Fetching AI models from database")
    const models = await getAIModels()

    log.info("AI models fetched successfully", {
      modelCount: models.length,
      activeCount: models.filter(m => m.active).length
    })

    timer({ status: "success", count: models.length })

    return createSuccess(models as unknown as SelectAiModel[], "Models retrieved successfully")
  } catch (error) {
    timer({ status: "error" })

    return handleError(error, "Failed to get AI models. Please try again or contact support.", {
      context: "getAiModels",
      requestId,
      operation: "getAiModels"
    })
  }
}

/**
 * Get models enabled for Assistant Architect
 * Returns only models with architectEnabled=true for prompt configuration
 */
export async function getArchitectModelsAction(): Promise<ActionState<SelectAiModel[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getArchitectModels")
  const log = createLogger({ requestId, action: "getArchitectModels" })

  try {
    log.info("Action started: Getting Architect-enabled models")

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized AI models access attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("User authenticated", { userId: session.sub })

    log.debug("Fetching Architect-enabled models from database")
    const models = await getArchitectEnabledModels()

    log.info("Architect models fetched successfully", {
      modelCount: models.length
    })

    timer({ status: "success", count: models.length })

    return createSuccess(models as unknown as SelectAiModel[], "Models retrieved successfully")
  } catch (error) {
    timer({ status: "error" })

    return handleError(error, "Failed to get AI models. Please try again or contact support.", {
      context: "getArchitectModels",
      requestId,
      operation: "getArchitectModels"
    })
  }
} 