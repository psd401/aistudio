/**
 * Drizzle ORM Relations Definitions
 *
 * Defines relationships between tables for type-safe joins and queries.
 * Generated from live database FK introspection via MCP tools.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #528 - Generate Drizzle schema from live database
 *
 * @see https://orm.drizzle.team/docs/relations
 */

import { relations } from "drizzle-orm";

// Core tables
import { users } from "./tables/users";
import { roles } from "./tables/roles";
import { userRoles } from "./tables/user-roles";
import { tools } from "./tables/tools";
import { roleTools } from "./tables/role-tools";

// AI Models
import { aiModels } from "./tables/ai-models";
import { aiStreamingJobs } from "./tables/ai-streaming-jobs";

// Assistant Architects
import { assistantArchitects } from "./tables/assistant-architects";
import { assistantArchitectEvents } from "./tables/assistant-architect-events";
import { chainPrompts } from "./tables/chain-prompts";
import { toolInputFields } from "./tables/tool-input-fields";
import { toolExecutions } from "./tables/tool-executions";
import { toolEdits } from "./tables/tool-edits";
import { promptResults } from "./tables/prompt-results";

// Nexus conversations
import { nexusConversations } from "./tables/nexus-conversations";
import { nexusFolders } from "./tables/nexus-folders";
import { nexusMessages } from "./tables/nexus-messages";
import { nexusConversationFolders } from "./tables/nexus-conversation-folders";
import { nexusConversationEvents } from "./tables/nexus-conversation-events";
import { nexusCacheEntries } from "./tables/nexus-cache-entries";
import { nexusShares } from "./tables/nexus-shares";
import { nexusTemplates } from "./tables/nexus-templates";
import { nexusUserPreferences } from "./tables/nexus-user-preferences";
import { nexusProviderMetrics } from "./tables/nexus-provider-metrics";

// Nexus MCP
import { nexusMcpServers } from "./tables/nexus-mcp-servers";
import { nexusMcpConnections } from "./tables/nexus-mcp-connections";
import { nexusMcpCapabilities } from "./tables/nexus-mcp-capabilities";
import { nexusMcpAuditLogs } from "./tables/nexus-mcp-audit-logs";

// Documents
import { documents } from "./tables/documents";
import { documentChunks } from "./tables/document-chunks";

// Knowledge repositories
import { knowledgeRepositories } from "./tables/knowledge-repositories";
import { repositoryItems } from "./tables/repository-items";
import { repositoryItemChunks } from "./tables/repository-item-chunks";
import { repositoryAccess } from "./tables/repository-access";
import { textractJobs } from "./tables/textract-jobs";

// Prompt library
import { promptLibrary } from "./tables/prompt-library";
import { promptTags } from "./tables/prompt-tags";
import { promptLibraryTags } from "./tables/prompt-library-tags";
import { promptUsageEvents } from "./tables/prompt-usage-events";

// Scheduling
import { jobs } from "./tables/jobs";
import { scheduledExecutions } from "./tables/scheduled-executions";
import { executionResults } from "./tables/execution-results";
import { userNotifications } from "./tables/user-notifications";

// Ideas
import { ideas } from "./tables/ideas";
import { ideaVotes } from "./tables/idea-votes";
import { ideaNotes } from "./tables/idea-notes";

// Navigation
import { navigationItems } from "./tables/navigation-items";
import { navigationItemRoles } from "./tables/navigation-item-roles";

// Model Management
import { modelComparisons } from "./tables/model-comparisons";
import { modelReplacementAudit } from "./tables/model-replacement-audit";

// Context Graph
import { graphNodes } from "./tables/graph-nodes";
import { graphEdges } from "./tables/graph-edges";

// ============================================
// User Relations
// ============================================

export const usersRelations = relations(users, ({ one, many }) => ({
  userRoles: many(userRoles),
  assistantArchitects: many(assistantArchitects),
  toolExecutions: many(toolExecutions),
  toolEdits: many(toolEdits),
  nexusConversations: many(nexusConversations),
  nexusFolders: many(nexusFolders),
  nexusShares: many(nexusShares),
  nexusTemplates: many(nexusTemplates),
  nexusMcpConnections: many(nexusMcpConnections),
  nexusMcpAuditLogs: many(nexusMcpAuditLogs),
  documents: many(documents),
  knowledgeRepositories: many(knowledgeRepositories),
  repositoryAccess: many(repositoryAccess),
  promptLibrary: many(promptLibrary),
  promptUsageEvents: many(promptUsageEvents),
  scheduledExecutions: many(scheduledExecutions),
  userNotifications: many(userNotifications),
  jobs: many(jobs),
  aiStreamingJobs: many(aiStreamingJobs),
  ideas: many(ideas),
  ideaVotes: many(ideaVotes),
  ideaNotes: many(ideaNotes),
  modelComparisons: many(modelComparisons),
  modelReplacementsPerformed: many(modelReplacementAudit),
  graphNodes: many(graphNodes),
  graphEdges: many(graphEdges),
  // One-to-one with nexus_user_preferences (user_id is the primary key)
  preferences: one(nexusUserPreferences, {
    fields: [users.id],
    references: [nexusUserPreferences.userId],
  }),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  userRoles: many(userRoles),
  roleTools: many(roleTools),
  repositoryAccess: many(repositoryAccess),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, {
    fields: [userRoles.userId],
    references: [users.id],
  }),
  role: one(roles, {
    fields: [userRoles.roleId],
    references: [roles.id],
  }),
}));

export const toolsRelations = relations(tools, ({ many }) => ({
  roleTools: many(roleTools),
  navigationItems: many(navigationItems),
}));

export const roleToolsRelations = relations(roleTools, ({ one }) => ({
  role: one(roles, {
    fields: [roleTools.roleId],
    references: [roles.id],
  }),
  tool: one(tools, {
    fields: [roleTools.toolId],
    references: [tools.id],
  }),
}));

// ============================================
// Assistant Architect Relations
// ============================================

export const assistantArchitectsRelations = relations(
  assistantArchitects,
  ({ one, many }) => ({
    user: one(users, {
      fields: [assistantArchitects.userId],
      references: [users.id],
    }),
    chainPrompts: many(chainPrompts),
    toolInputFields: many(toolInputFields),
    toolExecutions: many(toolExecutions),
    toolEdits: many(toolEdits),
    scheduledExecutions: many(scheduledExecutions),
  })
);

export const chainPromptsRelations = relations(chainPrompts, ({ one, many }) => ({
  assistantArchitect: one(assistantArchitects, {
    fields: [chainPrompts.assistantArchitectId],
    references: [assistantArchitects.id],
  }),
  model: one(aiModels, {
    fields: [chainPrompts.modelId],
    references: [aiModels.id],
  }),
  promptResults: many(promptResults),
}));

export const toolInputFieldsRelations = relations(toolInputFields, ({ one }) => ({
  assistantArchitect: one(assistantArchitects, {
    fields: [toolInputFields.assistantArchitectId],
    references: [assistantArchitects.id],
  }),
}));

export const toolExecutionsRelations = relations(toolExecutions, ({ one, many }) => ({
  user: one(users, {
    fields: [toolExecutions.userId],
    references: [users.id],
  }),
  assistantArchitect: one(assistantArchitects, {
    fields: [toolExecutions.assistantArchitectId],
    references: [assistantArchitects.id],
  }),
  promptResults: many(promptResults),
  events: many(assistantArchitectEvents),
}));

export const assistantArchitectEventsRelations = relations(
  assistantArchitectEvents,
  ({ one }) => ({
    execution: one(toolExecutions, {
      fields: [assistantArchitectEvents.executionId],
      references: [toolExecutions.id],
    }),
  })
);

export const toolEditsRelations = relations(toolEdits, ({ one }) => ({
  user: one(users, {
    fields: [toolEdits.userId],
    references: [users.id],
  }),
  assistantArchitect: one(assistantArchitects, {
    fields: [toolEdits.assistantArchitectId],
    references: [assistantArchitects.id],
  }),
}));

export const promptResultsRelations = relations(promptResults, ({ one }) => ({
  execution: one(toolExecutions, {
    fields: [promptResults.executionId],
    references: [toolExecutions.id],
  }),
  prompt: one(chainPrompts, {
    fields: [promptResults.promptId],
    references: [chainPrompts.id],
  }),
}));

// ============================================
// Nexus Conversation Relations
// ============================================

export const nexusConversationsRelations = relations(
  nexusConversations,
  ({ one, many }) => ({
    user: one(users, {
      fields: [nexusConversations.userId],
      references: [users.id],
    }),
    folder: one(nexusFolders, {
      fields: [nexusConversations.folderId],
      references: [nexusFolders.id],
    }),
    messages: many(nexusMessages),
    events: many(nexusConversationEvents),
    cacheEntries: many(nexusCacheEntries),
    shares: many(nexusShares),
    providerMetrics: many(nexusProviderMetrics),
    conversationFolders: many(nexusConversationFolders),
    promptLibrary: many(promptLibrary),
    promptUsageEvents: many(promptUsageEvents),
    documents: many(documents), // Added bidirectional relation for Issue #549
  })
);

export const nexusFoldersRelations = relations(nexusFolders, ({ one, many }) => ({
  user: one(users, {
    fields: [nexusFolders.userId],
    references: [users.id],
  }),
  parent: one(nexusFolders, {
    fields: [nexusFolders.parentId],
    references: [nexusFolders.id],
    relationName: "folderHierarchy",
  }),
  children: many(nexusFolders, { relationName: "folderHierarchy" }),
  conversations: many(nexusConversations),
  conversationFolders: many(nexusConversationFolders),
}));

export const nexusMessagesRelations = relations(nexusMessages, ({ one, many }) => ({
  conversation: one(nexusConversations, {
    fields: [nexusMessages.conversationId],
    references: [nexusConversations.id],
  }),
  model: one(aiModels, {
    fields: [nexusMessages.modelId],
    references: [aiModels.id],
  }),
  promptLibrary: many(promptLibrary),
}));

export const nexusConversationFoldersRelations = relations(
  nexusConversationFolders,
  ({ one }) => ({
    conversation: one(nexusConversations, {
      fields: [nexusConversationFolders.conversationId],
      references: [nexusConversations.id],
    }),
    folder: one(nexusFolders, {
      fields: [nexusConversationFolders.folderId],
      references: [nexusFolders.id],
    }),
  })
);

export const nexusConversationEventsRelations = relations(
  nexusConversationEvents,
  ({ one }) => ({
    conversation: one(nexusConversations, {
      fields: [nexusConversationEvents.conversationId],
      references: [nexusConversations.id],
    }),
  })
);

export const nexusCacheEntriesRelations = relations(nexusCacheEntries, ({ one }) => ({
  conversation: one(nexusConversations, {
    fields: [nexusCacheEntries.conversationId],
    references: [nexusConversations.id],
  }),
}));

export const nexusSharesRelations = relations(nexusShares, ({ one }) => ({
  conversation: one(nexusConversations, {
    fields: [nexusShares.conversationId],
    references: [nexusConversations.id],
  }),
  sharedByUser: one(users, {
    fields: [nexusShares.sharedBy],
    references: [users.id],
  }),
}));

export const nexusTemplatesRelations = relations(nexusTemplates, ({ one }) => ({
  user: one(users, {
    fields: [nexusTemplates.userId],
    references: [users.id],
  }),
}));

export const nexusProviderMetricsRelations = relations(
  nexusProviderMetrics,
  ({ one }) => ({
    conversation: one(nexusConversations, {
      fields: [nexusProviderMetrics.conversationId],
      references: [nexusConversations.id],
    }),
  })
);

export const nexusUserPreferencesRelations = relations(
  nexusUserPreferences,
  ({ one }) => ({
    user: one(users, {
      fields: [nexusUserPreferences.userId],
      references: [users.id],
    }),
  })
);

// ============================================
// Nexus MCP Relations
// ============================================

export const nexusMcpServersRelations = relations(nexusMcpServers, ({ many }) => ({
  connections: many(nexusMcpConnections),
  capabilities: many(nexusMcpCapabilities),
  auditLogs: many(nexusMcpAuditLogs),
}));

export const nexusMcpConnectionsRelations = relations(
  nexusMcpConnections,
  ({ one }) => ({
    server: one(nexusMcpServers, {
      fields: [nexusMcpConnections.serverId],
      references: [nexusMcpServers.id],
    }),
    user: one(users, {
      fields: [nexusMcpConnections.userId],
      references: [users.id],
    }),
  })
);

export const nexusMcpCapabilitiesRelations = relations(
  nexusMcpCapabilities,
  ({ one }) => ({
    server: one(nexusMcpServers, {
      fields: [nexusMcpCapabilities.serverId],
      references: [nexusMcpServers.id],
    }),
  })
);

export const nexusMcpAuditLogsRelations = relations(nexusMcpAuditLogs, ({ one }) => ({
  server: one(nexusMcpServers, {
    fields: [nexusMcpAuditLogs.serverId],
    references: [nexusMcpServers.id],
  }),
  user: one(users, {
    fields: [nexusMcpAuditLogs.userId],
    references: [users.id],
  }),
}));

// ============================================
// Knowledge Repository Relations
// ============================================

export const knowledgeRepositoriesRelations = relations(
  knowledgeRepositories,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [knowledgeRepositories.ownerId],
      references: [users.id],
    }),
    items: many(repositoryItems),
    access: many(repositoryAccess),
  })
);

export const repositoryItemsRelations = relations(
  repositoryItems,
  ({ one, many }) => ({
    repository: one(knowledgeRepositories, {
      fields: [repositoryItems.repositoryId],
      references: [knowledgeRepositories.id],
    }),
    chunks: many(repositoryItemChunks),
    textractJobs: many(textractJobs),
  })
);

export const repositoryItemChunksRelations = relations(
  repositoryItemChunks,
  ({ one }) => ({
    item: one(repositoryItems, {
      fields: [repositoryItemChunks.itemId],
      references: [repositoryItems.id],
    }),
  })
);

export const repositoryAccessRelations = relations(repositoryAccess, ({ one }) => ({
  repository: one(knowledgeRepositories, {
    fields: [repositoryAccess.repositoryId],
    references: [knowledgeRepositories.id],
  }),
  user: one(users, {
    fields: [repositoryAccess.userId],
    references: [users.id],
  }),
  role: one(roles, {
    fields: [repositoryAccess.roleId],
    references: [roles.id],
  }),
}));

export const textractJobsRelations = relations(textractJobs, ({ one }) => ({
  item: one(repositoryItems, {
    fields: [textractJobs.itemId],
    references: [repositoryItems.id],
  }),
}));

// ============================================
// Prompt Library Relations
// ============================================

export const promptLibraryRelations = relations(
  promptLibrary,
  ({ one, many }) => ({
    user: one(users, {
      fields: [promptLibrary.userId],
      references: [users.id],
    }),
    moderator: one(users, {
      fields: [promptLibrary.moderatedBy],
      references: [users.id],
      relationName: "promptModerator",
    }),
    sourceMessage: one(nexusMessages, {
      fields: [promptLibrary.sourceMessageId],
      references: [nexusMessages.id],
    }),
    sourceConversation: one(nexusConversations, {
      fields: [promptLibrary.sourceConversationId],
      references: [nexusConversations.id],
    }),
    tags: many(promptLibraryTags),
    usageEvents: many(promptUsageEvents),
  })
);

export const promptTagsRelations = relations(promptTags, ({ many }) => ({
  promptLibraryTags: many(promptLibraryTags),
}));

export const promptLibraryTagsRelations = relations(promptLibraryTags, ({ one }) => ({
  prompt: one(promptLibrary, {
    fields: [promptLibraryTags.promptId],
    references: [promptLibrary.id],
  }),
  tag: one(promptTags, {
    fields: [promptLibraryTags.tagId],
    references: [promptTags.id],
  }),
}));

export const promptUsageEventsRelations = relations(promptUsageEvents, ({ one }) => ({
  prompt: one(promptLibrary, {
    fields: [promptUsageEvents.promptId],
    references: [promptLibrary.id],
  }),
  user: one(users, {
    fields: [promptUsageEvents.userId],
    references: [users.id],
  }),
  conversation: one(nexusConversations, {
    fields: [promptUsageEvents.conversationId],
    references: [nexusConversations.id],
  }),
}));

// ============================================
// Scheduling Relations
// ============================================

export const scheduledExecutionsRelations = relations(
  scheduledExecutions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [scheduledExecutions.userId],
      references: [users.id],
    }),
    assistantArchitect: one(assistantArchitects, {
      fields: [scheduledExecutions.assistantArchitectId],
      references: [assistantArchitects.id],
    }),
    results: many(executionResults),
  })
);

export const executionResultsRelations = relations(
  executionResults,
  ({ one, many }) => ({
    scheduledExecution: one(scheduledExecutions, {
      fields: [executionResults.scheduledExecutionId],
      references: [scheduledExecutions.id],
    }),
    notifications: many(userNotifications),
  })
);

export const userNotificationsRelations = relations(userNotifications, ({ one }) => ({
  user: one(users, {
    fields: [userNotifications.userId],
    references: [users.id],
  }),
  executionResult: one(executionResults, {
    fields: [userNotifications.executionResultId],
    references: [executionResults.id],
  }),
}));

// ============================================
// AI Model Relations
// ============================================

export const aiModelsRelations = relations(aiModels, ({ many }) => ({
  chainPrompts: many(chainPrompts),
  nexusMessages: many(nexusMessages),
  aiStreamingJobs: many(aiStreamingJobs),
  comparisonsAsModel1: many(modelComparisons, { relationName: "model1" }),
  comparisonsAsModel2: many(modelComparisons, { relationName: "model2" }),
  replacementsAsOriginal: many(modelReplacementAudit, {
    relationName: "originalModel",
  }),
  replacementsAsReplacement: many(modelReplacementAudit, {
    relationName: "replacementModel",
  }),
}));

// ============================================
// Document Relations
// ============================================

export const documentsRelations = relations(documents, ({ one, many }) => ({
  user: one(users, {
    fields: [documents.userId],
    references: [users.id],
  }),
  conversation: one(nexusConversations, {
    fields: [documents.conversationId],
    references: [nexusConversations.id],
  }),
  chunks: many(documentChunks),
}));

export const documentChunksRelations = relations(documentChunks, ({ one }) => ({
  document: one(documents, {
    fields: [documentChunks.documentId],
    references: [documents.id],
  }),
}));

// ============================================
// Job Relations
// ============================================

export const jobsRelations = relations(jobs, ({ one }) => ({
  user: one(users, {
    fields: [jobs.userId],
    references: [users.id],
  }),
}));

export const aiStreamingJobsRelations = relations(aiStreamingJobs, ({ one }) => ({
  user: one(users, {
    fields: [aiStreamingJobs.userId],
    references: [users.id],
  }),
  model: one(aiModels, {
    fields: [aiStreamingJobs.modelId],
    references: [aiModels.id],
  }),
}));

// ============================================
// Ideas Relations
// ============================================

export const ideasRelations = relations(ideas, ({ one, many }) => ({
  user: one(users, {
    fields: [ideas.userId],
    references: [users.id],
  }),
  votes: many(ideaVotes),
  notes: many(ideaNotes),
}));

export const ideaVotesRelations = relations(ideaVotes, ({ one }) => ({
  idea: one(ideas, {
    fields: [ideaVotes.ideaId],
    references: [ideas.id],
  }),
  user: one(users, {
    fields: [ideaVotes.userId],
    references: [users.id],
  }),
}));

export const ideaNotesRelations = relations(ideaNotes, ({ one }) => ({
  idea: one(ideas, {
    fields: [ideaNotes.ideaId],
    references: [ideas.id],
  }),
  user: one(users, {
    fields: [ideaNotes.userId],
    references: [users.id],
  }),
}));

// ============================================
// Navigation Relations
// ============================================

export const navigationItemsRelations = relations(
  navigationItems,
  ({ one, many }) => ({
    tool: one(tools, {
      fields: [navigationItems.toolId],
      references: [tools.id],
    }),
    parent: one(navigationItems, {
      fields: [navigationItems.parentId],
      references: [navigationItems.id],
      relationName: "navigationHierarchy",
    }),
    children: many(navigationItems, { relationName: "navigationHierarchy" }),
    roles: many(navigationItemRoles),
  })
);

export const navigationItemRolesRelations = relations(
  navigationItemRoles,
  ({ one }) => ({
    navigationItem: one(navigationItems, {
      fields: [navigationItemRoles.navigationItemId],
      references: [navigationItems.id],
    }),
  })
);

// ============================================
// Model Comparison Relations
// ============================================

export const modelComparisonsRelations = relations(
  modelComparisons,
  ({ one }) => ({
    user: one(users, {
      fields: [modelComparisons.userId],
      references: [users.id],
    }),
    model1: one(aiModels, {
      fields: [modelComparisons.model1Id],
      references: [aiModels.id],
      relationName: "model1",
    }),
    model2: one(aiModels, {
      fields: [modelComparisons.model2Id],
      references: [aiModels.id],
      relationName: "model2",
    }),
  })
);

export const modelReplacementAuditRelations = relations(
  modelReplacementAudit,
  ({ one }) => ({
    originalModel: one(aiModels, {
      fields: [modelReplacementAudit.originalModelId],
      references: [aiModels.id],
      relationName: "originalModel",
    }),
    replacementModel: one(aiModels, {
      fields: [modelReplacementAudit.replacementModelId],
      references: [aiModels.id],
      relationName: "replacementModel",
    }),
    replacedByUser: one(users, {
      fields: [modelReplacementAudit.replacedBy],
      references: [users.id],
    }),
  })
);

// ============================================
// Context Graph Relations
// ============================================

export const graphNodesRelations = relations(graphNodes, ({ one, many }) => ({
  createdByUser: one(users, {
    fields: [graphNodes.createdBy],
    references: [users.id],
  }),
  outgoingEdges: many(graphEdges, { relationName: "sourceNode" }),
  incomingEdges: many(graphEdges, { relationName: "targetNode" }),
}));

export const graphEdgesRelations = relations(graphEdges, ({ one }) => ({
  sourceNode: one(graphNodes, {
    fields: [graphEdges.sourceNodeId],
    references: [graphNodes.id],
    relationName: "sourceNode",
  }),
  targetNode: one(graphNodes, {
    fields: [graphEdges.targetNodeId],
    references: [graphNodes.id],
    relationName: "targetNode",
  }),
  createdByUser: one(users, {
    fields: [graphEdges.createdBy],
    references: [users.id],
  }),
}));
