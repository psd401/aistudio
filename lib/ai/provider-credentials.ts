import { Settings } from "@/lib/settings-manager"
import { createLogger } from "@/lib/logger"

const log = createLogger({ module: "provider-credentials" })

const ALL_CHAT_PROVIDERS = ["openai", "google", "amazon-bedrock", "azure", "latimer"] as const

/**
 * Returns the lowercase provider identifiers whose credentials are configured
 * (database settings with environment fallback, cached by the settings
 * manager), so routing can skip models that would fail provider creation.
 *
 * amazon-bedrock is always included: it can authenticate through the default
 * AWS credential chain (ECS/Lambda IAM roles), which cannot be probed here.
 *
 * Fails open — a probe failure must not take chat down, so every provider is
 * treated as configured and a missing key surfaces at stream time as before.
 */
export async function getConfiguredChatProviders(): Promise<Set<string>> {
  try {
    const [openAiKey, googleKey, azure, latimerKey] = await Promise.all([
      Settings.getOpenAI(),
      Settings.getGoogleAI(),
      Settings.getAzureOpenAI(),
      Settings.getLatimer(),
    ])
    const configured = new Set<string>(["amazon-bedrock"])
    if (openAiKey?.trim()) configured.add("openai")
    if (googleKey?.trim()) configured.add("google")
    if (azure.key?.trim() && azure.resourceName?.trim()) configured.add("azure")
    if (latimerKey?.trim()) configured.add("latimer")
    return configured
  } catch (error) {
    log.warn("Provider credential probe failed; treating every provider as configured", {
      error: error instanceof Error ? error.message : String(error),
    })
    return new Set(ALL_CHAT_PROVIDERS)
  }
}
