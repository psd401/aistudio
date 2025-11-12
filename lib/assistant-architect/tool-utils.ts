import type { SelectChainPrompt } from "@/types/db-types"

/**
 * Collect all unique enabled tools from prompts in execution order
 * This utility ensures consistent tool collection logic across frontend and backend
 */
export function collectEnabledToolsFromPrompts(prompts: SelectChainPrompt[]): string[] {
  const allTools = new Set<string>();

  // Sort prompts by position to ensure correct execution order
  for (const prompt of prompts
    .sort((a, b) => (a.position || 0) - (b.position || 0))) {
      if (prompt.enabledTools && Array.isArray(prompt.enabledTools)) {
        for (const tool of prompt.enabledTools) {
          if (typeof tool === 'string' && tool.trim()) {
            allTools.add(tool.trim());
          }
        }
      }
    }

  return Array.from(allTools);
}

/**
 * Get display name for tools in the UI
 * Maps tool internal names to user-friendly display names
 */
export function getToolDisplayName(toolName: string): string {
  const toolDisplayNames: Record<string, string> = {
    'webSearch': 'Web Search',
    'web-search': 'Web Search',
    'web-scraper': 'Web Scraper',
    'file-reader': 'File Reader',
    'codeInterpreter': 'Code Interpreter',
    'code-interpreter': 'Code Interpreter',
    'image-generator': 'Image Generator',
    'generateImage': 'Image Generation',
    'calculator': 'Calculator'
  };

  return toolDisplayNames[toolName] || toolName.charAt(0).toUpperCase() + toolName.slice(1).replace(/[_-]/g, ' ');
}

/**
 * Validate and sanitize tool name format
 * Ensures tool names follow expected patterns
 */
export function sanitizeToolName(tool: string): string | null {
  if (typeof tool !== 'string' || !tool.trim()) {
    return null;
  }

  const sanitizedTool = tool.trim();

  // Allow alphanumeric characters, hyphens, and underscores
  // Must start with a letter
  if (/^[A-Za-z][\w-]*$/.test(sanitizedTool)) {
    return sanitizedTool;
  }

  return null;
}

/**
 * Enhanced tool collection with input sanitization
 * Combines collection logic with validation for secure tool handling
 */
export function collectAndSanitizeEnabledTools(prompts: SelectChainPrompt[]): string[] {
  const allTools = new Set<string>();

  // Sort prompts by position to ensure correct execution order
  for (const prompt of prompts
    .sort((a, b) => (a.position || 0) - (b.position || 0))) {
      if (prompt.enabledTools && Array.isArray(prompt.enabledTools)) {
        for (const tool of prompt.enabledTools) {
          const sanitizedTool = sanitizeToolName(tool);
          if (sanitizedTool) {
            allTools.add(sanitizedTool);
          }
        }
      }
    }

  return Array.from(allTools);
}