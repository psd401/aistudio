// Type definitions for database operations
// These types match the database structure

export type InsertJob = {
  id?: number;
  userId: number;
  status?: string;
  type: string;
  input: string;
  output?: string | null;
  error?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type SelectJob = {
  id: number;
  userId: number;
  status: string;
  type: string;
  input: string;
  output: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertNavigationItem = {
  id?: number;
  label: string;
  icon: string;
  link?: string | null;
  parentId?: number | null;
  description?: string | null;
  type?: string;
  toolId?: number | null;
  requiresRole?: string | null;
  position?: number;
  isActive?: boolean;
  createdAt?: Date;
}

export type SelectNavigationItem = {
  id: number;
  label: string;
  icon: string;
  link: string | null;
  parentId: number | null;
  description: string | null;
  type: string;
  toolId: number | null;
  requiresRole: string | null;
  position: number;
  isActive: boolean;
  createdAt: Date;
}

export type SelectUser = {
  id: number;
  cognitoSub: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  lastSignInAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SelectDocument = {
  id: number;
  name: string;
  type: string;
  url: string;
  size: number;
  userId: number;
  conversationId: number | null;
  metadata?: NexusConversationMetadata;
  createdAt: Date;
}

export type InsertDocument = {
  id?: number;
  name: string;
  type: string;
  url: string;
  size?: number;
  userId: number;
  conversationId?: number | null;
  metadata?: NexusConversationMetadata;
}

export type SelectDocumentChunk = {
  id: number;
  documentId: number;
  content: string;
  chunkIndex: number;
  metadata?: NexusConversationMetadata;
  createdAt: Date;
}

export type InsertDocumentChunk = {
  id?: number;
  documentId: number;
  content: string;
  chunkIndex: number;
  metadata?: NexusConversationMetadata;
}

export type SelectAssistantArchitect = {
  id: number;
  name: string;
  description: string | null;
  status: string;
  imagePath: string | null;
  userId: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolInputFieldOptions {
  values?: string[];
  multiSelect?: boolean;
  placeholder?: string;
  [key: string]: unknown;
}

export interface NexusCapabilities {
  canvas: boolean;
  thinking: boolean;
  artifacts: boolean;
  grounding: boolean;
  reasoning: boolean;
  webSearch: boolean;
  computerUse: boolean;
  responsesAPI: boolean;
  codeExecution: boolean;
  promptCaching: boolean;
  contextCaching: boolean;
  workspaceTools: boolean;
  codeInterpreter: boolean;
  [key: string]: boolean; // Allow string indexing for dynamic access
}

export interface ProviderMetadata {
  max_context_length?: number;
  supports_streaming?: boolean;
  supports_function_calling?: boolean;
  [key: string]: unknown;
}

export type SelectToolInputField = {
  id: number;
  assistantArchitectId: number;
  name: string;
  label: string;
  fieldType: string;
  options: ToolInputFieldOptions | string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export type SelectChainPrompt = {
  id: number;
  assistantArchitectId: number;
  name: string;
  content: string;
  systemContext: string | null;
  modelId: number | null;
  position: number;
  inputMapping: Record<string, unknown> | null;
  parallelGroup: number | null;
  timeoutSeconds: number | null;
  repositoryIds: number[] | null;
  enabledTools: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SelectToolExecution = {
  id: number;
  assistantArchitectId: number;
  userId: number;
  inputData: Record<string, unknown>;
  status: string;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export type SelectPromptResult = {
  id: number;
  toolExecutionId: number;
  chainPromptId: number;
  result: string;
  aiModelId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertAssistantArchitect = {
  id?: number;
  name: string;
  description?: string;
  status?: string;
  imagePath?: string;
  userId?: number;
}

export type InsertToolInputField = {
  id?: number;
  assistantArchitectId: number;
  name: string;
  label: string;
  fieldType: string;
  options?: ToolInputFieldOptions | { label: string; value: string }[];
  position?: number;
}

export type InsertChainPrompt = {
  id?: number;
  assistantArchitectId: number;
  name: string;
  content: string;
  systemContext?: string;
  modelId?: number;
  position?: number;
  inputMapping?: Record<string, string> | null;
  parallelGroup?: number;
  timeoutSeconds?: number;
  repositoryIds?: number[];
  enabledTools?: string[];
}

export type InsertToolExecution = {
  id?: number;
  assistantArchitectId: number;
  userId: number;
  inputData: Record<string, unknown>;
  status?: string;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export type InsertPromptResult = {
  id?: number;
  toolExecutionId: number;
  chainPromptId: number;
  result: string;
  aiModelId?: number;
}

export type SelectTool = {
  id: number;
  identifier: string;
  name: string;
  description: string | null;
  promptChainToolId: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type SelectAiModel = {
  id: number;
  name: string;
  modelId: string;
  provider: string | null;
  description: string | null;
  capabilities: string | null;
  maxTokens: number | null;
  active: boolean;
  chatEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  allowedRoles?: string | null;
  // Pricing fields
  inputCostPer1kTokens: number | null;
  outputCostPer1kTokens: number | null;
  cachedInputCostPer1kTokens: number | null;
  pricingUpdatedAt: Date | null;
  // Performance fields
  averageLatencyMs: number | null;
  maxConcurrency: number | null;
  supportsBatching: boolean | null;
  // Capability/Metadata fields (JSONB)
  nexusCapabilities: NexusCapabilities | null;
  providerMetadata: ProviderMetadata | null;
}

// =====================================================
// NEXUS DATABASE TYPES
// =====================================================

// JSONB interfaces for type safety
export interface NexusConversationMetadata {
  tags?: string[];
  customFields?: Record<string, unknown>;
  providerData?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NexusFolderSettings {
  sortBy?: 'name' | 'updated' | 'created';
  viewMode?: 'list' | 'grid';
  autoArchive?: boolean;
  [key: string]: unknown;
}

export interface NexusUserSettings {
  theme?: 'light' | 'dark' | 'system';
  notifications?: boolean;
  shortcuts?: Record<string, string>;
  [key: string]: unknown;
}

export interface NexusConversationEventData {
  eventType: 'created' | 'updated' | 'archived' | 'shared' | 'moved' | 'deleted';
  userId: number;
  changes?: Record<string, unknown>;
  timestamp: string;
  [key: string]: unknown;
}

export interface NexusMcpSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface NexusMcpAuditData {
  requestId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NexusTemplateVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  required?: boolean;
  default?: unknown;
}

// Nexus Conversations
export type SelectNexusConversation = {
  id: string;
  userId: number;
  provider: 'openai' | 'anthropic' | 'google' | 'azure' | 'local';
  externalId: string | null;
  cacheKey: string | null;
  title: string | null;
  modelUsed: string | null;
  folderId: string | null;
  messageCount: number;
  totalTokens: number;
  lastMessageAt: Date;
  isArchived: boolean;
  isPinned: boolean;
  metadata: NexusConversationMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertNexusConversation = {
  id?: string;
  userId: number;
  provider: 'openai' | 'anthropic' | 'google' | 'azure' | 'local';
  externalId?: string;
  cacheKey?: string;
  title?: string;
  modelUsed?: string;
  folderId?: string;
  messageCount?: number;
  totalTokens?: number;
  lastMessageAt?: Date;
  isArchived?: boolean;
  isPinned?: boolean;
  metadata?: NexusConversationMetadata;
}

// Nexus Folders
export type SelectNexusFolder = {
  id: string;
  userId: number;
  parentId: string | null;
  name: string;
  color: string;
  icon: string;
  sortOrder: number;
  isExpanded: boolean;
  settings: NexusFolderSettings;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertNexusFolder = {
  id?: string;
  userId: number;
  parentId?: string;
  name: string;
  color?: string;
  icon?: string;
  sortOrder?: number;
  isExpanded?: boolean;
  settings?: NexusFolderSettings;
}

// Nexus User Preferences
export type SelectNexusUserPreferences = {
  userId: number;
  expandedFolders: string[];
  panelWidth: number;
  sortPreference: string;
  viewMode: string;
  settings: NexusUserSettings;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertNexusUserPreferences = {
  userId: number;
  expandedFolders?: string[];
  panelWidth?: number;
  sortPreference?: string;
  viewMode?: string;
  settings?: NexusUserSettings;
}

// Nexus Conversation Events
export type SelectNexusConversationEvent = {
  id: string;
  conversationId: string;
  eventType: string;
  eventData: NexusConversationEventData;
  createdAt: Date;
}

export type InsertNexusConversationEvent = {
  id?: string;
  conversationId: string;
  eventType: string;
  eventData: NexusConversationEventData;
}

// Nexus Cache Entries
export type SelectNexusCacheEntry = {
  cacheKey: string;
  provider: string;
  conversationId: string | null;
  ttl: number;
  expiresAt: Date;
  hitCount: number;
  byteSize: number | null;
  createdAt: Date;
}

export type InsertNexusCacheEntry = {
  cacheKey: string;
  provider: string;
  conversationId?: string;
  ttl: number;
  expiresAt: Date;
  hitCount?: number;
  byteSize?: number;
}

// Nexus MCP Servers
export type SelectNexusMcpServer = {
  id: string;
  name: string;
  url: string;
  transport: 'stdio' | 'http' | 'websocket';
  authType: 'api_key' | 'oauth' | 'jwt' | 'none';
  credentialsKey: string | null;
  allowedUsers: number[] | null;
  maxConnections: number;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertNexusMcpServer = {
  id?: string;
  name: string;
  url: string;
  transport: 'stdio' | 'http' | 'websocket';
  authType: 'api_key' | 'oauth' | 'jwt' | 'none';
  credentialsKey?: string;
  allowedUsers?: number[];
  maxConnections?: number;
}

// Nexus MCP Capabilities
export type SelectNexusMcpCapability = {
  id: string;
  serverId: string;
  type: 'tool' | 'resource' | 'prompt';
  name: string;
  description: string | null;
  inputSchema: NexusMcpSchema;
  outputSchema: NexusMcpSchema | null;
  sandboxLevel: 'standard' | 'strict' | 'none';
  rateLimit: number;
}

export type InsertNexusMcpCapability = {
  id?: string;
  serverId: string;
  type: 'tool' | 'resource' | 'prompt';
  name: string;
  description?: string;
  inputSchema: NexusMcpSchema;
  outputSchema?: NexusMcpSchema;
  sandboxLevel?: 'standard' | 'strict' | 'none';
  rateLimit?: number;
}

// Nexus MCP Connections
export type SelectNexusMcpConnection = {
  id: string;
  serverId: string;
  userId: number;
  status: 'connected' | 'disconnected' | 'error' | 'connecting';
  lastHealthCheck: Date | null;
  latencyMs: number | null;
  errorCount: number;
  successCount: number;
  circuitState: 'open' | 'closed' | 'half_open';
  lastError: string | null;
  lastConnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertNexusMcpConnection = {
  id?: string;
  serverId: string;
  userId: number;
  status: 'connected' | 'disconnected' | 'error' | 'connecting';
  lastHealthCheck?: Date;
  latencyMs?: number;
  errorCount?: number;
  successCount?: number;
  circuitState?: 'open' | 'closed' | 'half_open';
  lastError?: string;
  lastConnectedAt?: Date;
}

// Nexus MCP Audit Logs
export type SelectNexusMcpAuditLog = {
  id: string;
  userId: number;
  serverId: string;
  toolName: string;
  input: NexusMcpAuditData | null;
  output: NexusMcpAuditData | null;
  error: string | null;
  durationMs: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export type InsertNexusMcpAuditLog = {
  id?: string;
  userId: number;
  serverId: string;
  toolName: string;
  input?: NexusMcpAuditData;
  output?: NexusMcpAuditData;
  error?: string;
  durationMs?: number;
  ipAddress?: string;
  userAgent?: string;
}

// Nexus Templates
export type SelectNexusTemplate = {
  id: string;
  userId: number | null;
  name: string;
  description: string | null;
  prompt: string;
  variables: NexusTemplateVariable[];
  isPublic: boolean;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertNexusTemplate = {
  id?: string;
  userId?: number;
  name: string;
  description?: string;
  prompt: string;
  variables?: NexusTemplateVariable[];
  isPublic?: boolean;
  usageCount?: number;
}

// Nexus Shares
export type SelectNexusShare = {
  id: string;
  conversationId: string;
  sharedBy: number;
  shareToken: string;
  expiresAt: Date | null;
  viewCount: number;
  createdAt: Date;
}

export type InsertNexusShare = {
  id?: string;
  conversationId: string;
  sharedBy: number;
  shareToken: string;
  expiresAt?: Date;
  viewCount?: number;
}

// Nexus Conversation Folders (Junction Table)
export type SelectNexusConversationFolder = {
  conversationId: string;
  folderId: string;
  position: number;
  pinned: boolean;
  archivedAt: Date | null;
}

export type InsertNexusConversationFolder = {
  conversationId: string;
  folderId: string;
  position?: number;
  pinned?: boolean;
  archivedAt?: Date;
}

// =====================================================
// PROMPT LIBRARY TYPES
// =====================================================

// Prompt Library - Main prompts table
export type SelectPromptLibrary = {
  id: string;
  userId: number;
  title: string;
  content: string;
  description: string | null;
  visibility: 'private' | 'public';
  moderationStatus: 'pending' | 'approved' | 'rejected';
  moderatedBy: number | null;
  moderatedAt: Date | null;
  moderationNotes: string | null;
  sourceMessageId: string | null;
  sourceConversationId: string | null;
  viewCount: number;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export type InsertPromptLibrary = {
  id?: string;
  userId: number;
  title: string;
  content: string;
  description?: string;
  visibility?: 'private' | 'public';
  moderationStatus?: 'pending' | 'approved' | 'rejected';
  moderatedBy?: number;
  moderatedAt?: Date;
  moderationNotes?: string;
  sourceMessageId?: string;
  sourceConversationId?: string;
  viewCount?: number;
  useCount?: number;
  deletedAt?: Date;
}

// Prompt Tags - Tag taxonomy
export type SelectPromptTag = {
  id: number;
  name: string;
  createdAt: Date;
}

export type InsertPromptTag = {
  id?: number;
  name: string;
}

// Prompt Library Tags - Many-to-many relationship
export type SelectPromptLibraryTag = {
  promptId: string;
  tagId: number;
  createdAt: Date;
}

export type InsertPromptLibraryTag = {
  promptId: string;
  tagId: number;
}

// Prompt Usage Events - Analytics tracking
export type SelectPromptUsageEvent = {
  id: number;
  promptId: string;
  userId: number;
  eventType: 'view' | 'use' | 'share';
  conversationId: string | null;
  createdAt: Date;
}

export type InsertPromptUsageEvent = {
  id?: number;
  promptId: string;
  userId: number;
  eventType: 'view' | 'use' | 'share';
  conversationId?: string;
}

// =====================================================
// SCHEDULE MANAGEMENT TYPES
// =====================================================

// Schedule Config interface for JSONB field
export interface ScheduleConfig {
  frequency: 'daily' | 'weekly' | 'monthly' | 'custom';
  time?: string;
  timezone?: string;
  cron?: string;
  [key: string]: unknown;
}

// Scheduled Executions
export type SelectScheduledExecution = {
  id: number;
  userId: number;
  assistantArchitectId: number;
  name: string;
  scheduleConfig: ScheduleConfig;
  inputData: Record<string, string>;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

export type InsertScheduledExecution = {
  id?: number;
  userId: number;
  assistantArchitectId: number;
  name: string;
  scheduleConfig: ScheduleConfig;
  inputData: Record<string, string>;
  active?: boolean;
  updatedBy?: string;
}

// Execution Results
export type SelectExecutionResult = {
  id: number;
  scheduledExecutionId: number;
  resultData: Record<string, unknown>;
  status: 'success' | 'failed' | 'running';
  executedAt: Date;
  executionDurationMs: number | null;
  errorMessage: string | null;
}

export type InsertExecutionResult = {
  id?: number;
  scheduledExecutionId: number;
  resultData: Record<string, unknown>;
  status: 'success' | 'failed' | 'running';
  executedAt?: Date;
  executionDurationMs?: number;
  errorMessage?: string;
}

// User Notifications
export type SelectUserNotification = {
  id: number;
  userId: number;
  executionResultId: number;
  type: 'email' | 'in_app';
  status: 'sent' | 'delivered' | 'read' | 'failed';
  deliveryAttempts: number;
  lastAttemptAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

export type InsertUserNotification = {
  id?: number;
  userId: number;
  executionResultId: number;
  type: 'email' | 'in_app';
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  deliveryAttempts?: number;
  lastAttemptAt?: Date;
  failureReason?: string;
}