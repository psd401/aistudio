"use client"

import { createContext, useContext } from "react"

/**
 * Configuration context for passing current chat settings (model, tools, connectors)
 * to descendant components like PromptSaveButton.
 */
export interface ChatConfig {
  modelId?: string
  tools: string[]
  connectors: string[]
}

export const ChatConfigContext = createContext<ChatConfig>({ tools: [], connectors: [] })

export const useChatConfig = () => useContext(ChatConfigContext)
