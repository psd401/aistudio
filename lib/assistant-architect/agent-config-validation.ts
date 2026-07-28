import { getScopesForRoles } from "@/lib/api-keys/scopes";
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog";

export interface AgentToolValidationResult {
  isValid: boolean;
  invalidTools: string[];
  message?: string;
}

/**
 * Validate agentic tool identifiers against the author's role-derived scopes.
 *
 * Execution performs a second caller-side authorization check; this author-side
 * check prevents an import or ordinary editor save from persisting tools that
 * the author could not configure themselves.
 */
export async function validateAgentToolsForAuthor(
  agentEnabledTools: string[],
  authorRoleNames: string[],
): Promise<AgentToolValidationResult> {
  if (agentEnabledTools.length === 0) {
    return { isValid: true, invalidTools: [] };
  }

  try {
    const allowed = await toolCatalogInstance.list({
      surface: "internal",
      scopes: getScopesForRoles(authorRoleNames),
      agentOnly: true,
    });
    const allowedIdentifiers = new Set(allowed.map((entry) => entry.identifier));
    const invalidTools = agentEnabledTools.filter(
      (identifier) => !allowedIdentifiers.has(identifier),
    );
    if (invalidTools.length > 0) {
      return {
        isValid: false,
        invalidTools,
        message: `Tools not available for agentic use with your permissions: ${invalidTools.length} not accessible`,
      };
    }
    return { isValid: true, invalidTools: [] };
  } catch (error) {
    return {
      isValid: false,
      invalidTools: agentEnabledTools,
      message: `Error validating agent tools: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Validate connector identifiers against the importing author's visibility.
 * The response reports only a count so caller-controlled identifiers are not
 * reflected into logs or API responses.
 */
export async function validateAgentConnectorsForAuthor(
  connectorIds: string[],
  authorUserId: number,
  authorRoleNames: string[],
): Promise<string | null> {
  if (connectorIds.length === 0) return null;

  const { getAvailableConnectors } = await import(
    "@/lib/mcp/connector-service"
  );
  const accessible = await getAvailableConnectors(
    authorUserId,
    authorRoleNames,
  );
  const accessibleIds = new Set(accessible.map((connector) => connector.id));
  const invalidCount = connectorIds.filter(
    (identifier) => !accessibleIds.has(identifier),
  ).length;
  return invalidCount > 0
    ? `Connectors not available with your permissions: ${invalidCount} not accessible`
    : null;
}
