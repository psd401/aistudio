"use server";

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils";
import type { ActionState } from "@/types";
import { requireRole } from "@/lib/auth/role-helpers";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  eq,
  sql,
  desc,
  count,
  gte,
  and,
  ilike,
  or,
  asc,
  notInArray,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { users } from "@/lib/db/schema";
import { nexusConversations } from "@/lib/db/schema/tables/nexus-conversations";
import { nexusMessages } from "@/lib/db/schema/tables/nexus-messages";
import { modelComparisons } from "@/lib/db/schema/tables/model-comparisons";
import { aiModels } from "@/lib/db/schema/tables/ai-models";
import { getDateThreshold } from "@/lib/date-utils";

// Providers that represent non-chat conversation types (assistant executions, decision captures, etc.)
// These should be excluded from the "Nexus Conversations" tab in the activity dashboard
const NON_CHAT_PROVIDERS = ["assistant-architect", "decision-capture"] as const;

export type StatsDateRange = "30d" | "this-month" | "6m" | "this-year" | "all";

function getStatsDateRange(range: StatsDateRange): Date | null {
  const now = new Date();
  switch (range) {
    case "30d":
      return getDateThreshold(30);
    case "this-month":
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case "6m":
      return getDateThreshold(180);
    case "this-year":
      return new Date(now.getFullYear(), 0, 1);
    case "all":
      return null;
  }
}

// ============================================
// Types
// ============================================

export interface ActivityStats {
  totalNexusConversations: number;
  totalArchitectExecutions: number;
  totalComparisons: number;
  nexus24h: number;
  executions24h: number;
  comparisons24h: number;
  nexus7d: number;
  executions7d: number;
  comparisons7d: number;
  activeUsers7d: number;
  totalCostUsd: number;
  cost24hUsd: number;
  cost7dUsd: number;
}

export interface NexusActivityItem {
  id: string;
  userId: number;
  userEmail: string | null;
  userName: string;
  title: string | null;
  provider: string;
  modelUsed: string | null;
  messageCount: number;
  totalTokens: number;
  costUsd: number;
  lastMessageAt: Date | null;
  createdAt: Date | null;
}

export interface NexusMessageItem {
  id: string;
  role: string;
  content: string | null;
  tokenUsage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  } | null;
  createdAt: Date | null;
}

export interface ComparisonActivityItem {
  id: number;
  userId: number | null;
  userName: string;
  userEmail: string | null;
  prompt: string;
  model1Name: string | null;
  model2Name: string | null;
  executionTimeMs1: number | null;
  executionTimeMs2: number | null;
  tokensUsed1: number | null;
  tokensUsed2: number | null;
  costUsd: number;
  createdAt: Date | null;
}

export interface ComparisonDetailItem extends ComparisonActivityItem {
  response1: string | null;
  response2: string | null;
  metadata: Record<string, unknown>;
}

export interface AssistantConversationItem {
  id: string;
  userId: number;
  userEmail: string | null;
  userName: string;
  title: string | null;
  assistantName: string | null;
  executionStatus: string | null;
  modelUsed: string | null;
  messageCount: number;
  totalTokens: number;
  costUsd: number;
  lastMessageAt: Date | null;
  createdAt: Date | null;
}

export interface ActivityFilters {
  search?: string;
  userId?: number;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

interface ActivityWindow {
  rangeStart: Date | null;
  oneDayAgo: Date;
  sevenDaysAgo: Date;
}

interface WindowCounts {
  total: number;
  last24h: number;
  last7d: number;
}

async function conversationCount(
  filter: SQL,
  since: Date | null,
  operation: string,
): Promise<number> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ count: count() })
        .from(nexusConversations)
        .where(
          since
            ? and(filter, gte(nexusConversations.createdAt, since))
            : filter,
        ),
    operation,
  );
  return rows[0]?.count ?? 0;
}

async function conversationCounts(
  filter: SQL,
  window: ActivityWindow,
  prefix: string,
): Promise<WindowCounts> {
  const [total, last24h, last7d] = await Promise.all([
    conversationCount(filter, window.rangeStart, `${prefix}Total`),
    conversationCount(filter, window.oneDayAgo, `${prefix}24h`),
    conversationCount(filter, window.sevenDaysAgo, `${prefix}7d`),
  ]);
  return { total, last24h, last7d };
}

async function comparisonCount(
  since: Date | null,
  operation: string,
): Promise<number> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ count: count() })
        .from(modelComparisons)
        .where(since ? gte(modelComparisons.createdAt, since) : undefined),
    operation,
  );
  return rows[0]?.count ?? 0;
}

async function comparisonCounts(window: ActivityWindow): Promise<WindowCounts> {
  const [total, last24h, last7d] = await Promise.all([
    comparisonCount(window.rangeStart, "getActivityStats-comparisonsTotal"),
    comparisonCount(window.oneDayAgo, "getActivityStats-comparisons24h"),
    comparisonCount(window.sevenDaysAgo, "getActivityStats-comparisons7d"),
  ]);
  return { total, last24h, last7d };
}

async function conversationCost(
  since: Date | null,
  operation: string,
): Promise<number> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          total: sql<string>`COALESCE(SUM(
            ${nexusConversations.totalTokens}::numeric
            * (COALESCE(${aiModels.inputCostPer1kTokens}, 0) + COALESCE(${aiModels.outputCostPer1kTokens}, 0))
            / 2.0 / 1000.0
          ), 0)`,
        })
        .from(nexusConversations)
        .leftJoin(
          aiModels,
          and(
            eq(nexusConversations.provider, aiModels.provider),
            eq(nexusConversations.modelUsed, aiModels.modelId),
          ),
        )
        .where(since ? gte(nexusConversations.createdAt, since) : undefined),
    operation,
  );
  return Number.parseFloat(String(rows[0]?.total ?? "0"));
}

async function imageGenerationCost(
  since: Date | null,
  operation: string,
): Promise<number> {
  const hasCost = sql`${nexusMessages.metadata}->>'estimatedCost' IS NOT NULL`;
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          total: sql<string>`COALESCE(SUM((${nexusMessages.metadata}->>'estimatedCost')::numeric), 0)`,
        })
        .from(nexusMessages)
        .where(
          since ? and(hasCost, gte(nexusMessages.createdAt, since)) : hasCost,
        ),
    operation,
  );
  return Number.parseFloat(String(rows[0]?.total ?? "0"));
}

async function comparisonCost(
  since: Date | null,
  operation: string,
): Promise<number> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          total: sql<string>`COALESCE(SUM(
            COALESCE(${modelComparisons.tokensUsed1}::numeric * (
              COALESCE((SELECT am1.input_cost_per_1k_tokens FROM ai_models am1 WHERE am1.id = ${modelComparisons.model1Id}), 0)
              + COALESCE((SELECT am1.output_cost_per_1k_tokens FROM ai_models am1 WHERE am1.id = ${modelComparisons.model1Id}), 0)
            ) / 2.0 / 1000.0, 0)
            + COALESCE(${modelComparisons.tokensUsed2}::numeric * (
              COALESCE((SELECT am2.input_cost_per_1k_tokens FROM ai_models am2 WHERE am2.id = ${modelComparisons.model2Id}), 0)
              + COALESCE((SELECT am2.output_cost_per_1k_tokens FROM ai_models am2 WHERE am2.id = ${modelComparisons.model2Id}), 0)
            ) / 2.0 / 1000.0, 0)
          ), 0)`,
        })
        .from(modelComparisons)
        .where(since ? gte(modelComparisons.createdAt, since) : undefined),
    operation,
  );
  return Number.parseFloat(String(rows[0]?.total ?? "0"));
}

async function totalCostForWindow(
  since: Date | null,
  suffix: string,
): Promise<number> {
  const [conversations, images, comparisons] = await Promise.all([
    conversationCost(since, `getActivityStats-cost${suffix}`),
    imageGenerationCost(since, `getActivityStats-imageGenCost${suffix}`),
    comparisonCost(since, `getActivityStats-comparisonCost${suffix}`),
  ]);
  return conversations + images + comparisons;
}

async function activeUsersLast7Days(since: Date): Promise<number> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          count: sql<number>`count(distinct ${nexusConversations.userId})::int`,
        })
        .from(nexusConversations)
        .where(gte(nexusConversations.createdAt, since)),
    "getActivityStats-activeUsers",
  );
  return rows[0]?.count ?? 0;
}

async function loadActivityStats(
  window: ActivityWindow,
): Promise<ActivityStats> {
  const chatOnly = notInArray(nexusConversations.provider, [
    ...NON_CHAT_PROVIDERS,
  ]);
  const assistantOnly = eq(nexusConversations.provider, "assistant-architect");
  const [nexus, assistant, comparisons, activeUsers7d, costs] =
    await Promise.all([
      conversationCounts(chatOnly, window, "getActivityStats-nexus"),
      conversationCounts(
        assistantOnly,
        window,
        "getActivityStats-assistantConv",
      ),
      comparisonCounts(window),
      activeUsersLast7Days(window.sevenDaysAgo),
      Promise.all([
        totalCostForWindow(window.rangeStart, "Total"),
        totalCostForWindow(window.oneDayAgo, "24h"),
        totalCostForWindow(window.sevenDaysAgo, "7d"),
      ]),
    ]);
  return {
    totalNexusConversations: nexus.total,
    totalArchitectExecutions: assistant.total,
    totalComparisons: comparisons.total,
    nexus24h: nexus.last24h,
    executions24h: assistant.last24h,
    comparisons24h: comparisons.last24h,
    nexus7d: nexus.last7d,
    executions7d: assistant.last7d,
    comparisons7d: comparisons.last7d,
    activeUsers7d,
    totalCostUsd: costs[0],
    cost24hUsd: costs[1],
    cost7dUsd: costs[2],
  };
}

function activityPagination(filters: ActivityFilters | undefined): {
  pageSize: number;
  offset: number;
} {
  const page = filters?.page ?? 1;
  const pageSize = Math.min(filters?.pageSize ?? 25, 100);
  if (page < 1) {
    throw ErrorFactories.invalidInput("page", page, "Must be >= 1");
  }
  if (pageSize < 1 || pageSize > 100) {
    throw ErrorFactories.invalidInput(
      "pageSize",
      pageSize,
      "Must be between 1 and 100",
    );
  }
  return { pageSize, offset: (page - 1) * pageSize };
}

function activitySearchTerm(
  filters: ActivityFilters | undefined,
): string | null {
  if (!filters?.search) return null;
  const input = filters.search.trim();
  if (input.length > 100) {
    throw ErrorFactories.invalidInput(
      "search",
      input,
      "Must be 100 characters or less",
    );
  }
  if (input.length === 0) return null;
  return `%${input
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")}%`;
}

function conversationActivityConditions(
  filters: ActivityFilters | undefined,
  mode: "chat" | "assistant",
): SQL[] {
  const conditions: SQL[] = [
    mode === "chat"
      ? notInArray(nexusConversations.provider, [...NON_CHAT_PROVIDERS])
      : eq(nexusConversations.provider, "assistant-architect"),
  ];
  const searchTerm = activitySearchTerm(filters);
  if (searchTerm) {
    const ordinaryFields = [
      ilike(nexusConversations.title, searchTerm),
      ilike(users.email, searchTerm),
      ilike(users.firstName, searchTerm),
      ilike(users.lastName, searchTerm),
    ];
    const assistantName = sql`${nexusConversations.metadata}->>'assistantName' ILIKE ${searchTerm}`;
    conditions.push(
      or(...ordinaryFields, ...(mode === "assistant" ? [assistantName] : []))!,
    );
  }
  if (filters?.userId) {
    conditions.push(eq(nexusConversations.userId, filters.userId));
  }
  if (filters?.dateFrom) {
    conditions.push(
      gte(nexusConversations.createdAt, new Date(filters.dateFrom)),
    );
  }
  if (filters?.dateTo) {
    const endDate = new Date(filters.dateTo);
    endDate.setHours(23, 59, 59, 999);
    conditions.push(sql`${nexusConversations.createdAt} <= ${endDate}`);
  }
  return conditions;
}

function comparisonActivityConditions(
  filters: ActivityFilters | undefined,
): SQL[] {
  const conditions: SQL[] = [];
  if (filters?.userId) {
    conditions.push(eq(modelComparisons.userId, filters.userId));
  }
  if (filters?.dateFrom) {
    conditions.push(
      gte(modelComparisons.createdAt, new Date(filters.dateFrom)),
    );
  }
  if (filters?.dateTo) {
    const endDate = new Date(filters.dateTo);
    endDate.setHours(23, 59, 59, 999);
    conditions.push(sql`${modelComparisons.createdAt} <= ${endDate}`);
  }
  const searchTerm = activitySearchTerm(filters);
  if (searchTerm) {
    conditions.push(
      or(
        ilike(modelComparisons.prompt, searchTerm),
        ilike(modelComparisons.model1Name, searchTerm),
        ilike(modelComparisons.model2Name, searchTerm),
        ilike(users.email, searchTerm),
      )!,
    );
  }
  return conditions;
}

// ============================================
// Server Actions
// ============================================

/**
 * Get activity dashboard statistics
 */
export async function getActivityStats(
  dateRange: StatsDateRange = "30d",
): Promise<ActionState<ActivityStats>> {
  const requestId = generateRequestId();
  const timer = startTimer("getActivityStats");
  const log = createLogger({ requestId, action: "getActivityStats" });

  try {
    log.info("Fetching activity stats", { dateRange });

    // Verify admin role
    await requireRole("administrator");

    const stats = await loadActivityStats({
      oneDayAgo: getDateThreshold(1),
      sevenDaysAgo: getDateThreshold(7),
      rangeStart: getStatsDateRange(dateRange),
    });
    timer({ status: "success" });
    log.info("Activity stats fetched", sanitizeForLogging(stats));

    return createSuccess(stats, "Stats fetched successfully");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to fetch activity stats", {
      context: "getActivityStats",
      requestId,
      operation: "getActivityStats",
    });
  }
}

/**
 * Get paginated Nexus conversations with user info
 */
export async function getNexusActivity(
  filters?: ActivityFilters,
): Promise<ActionState<{ items: NexusActivityItem[]; total: number }>> {
  const requestId = generateRequestId();
  const timer = startTimer("getNexusActivity");
  const log = createLogger({ requestId, action: "getNexusActivity" });

  try {
    log.info("Fetching Nexus activity", {
      filters: sanitizeForLogging(filters),
    });

    await requireRole("administrator");

    const { pageSize, offset } = activityPagination(filters);
    const whereClause = and(...conversationActivityConditions(filters, "chat"));

    // Estimated cost per conversation: token-based cost + image generation cost
    const costSubquery = sql<string>`COALESCE(
      ${nexusConversations.totalTokens}::numeric
      * (COALESCE(${aiModels.inputCostPer1kTokens}, 0) + COALESCE(${aiModels.outputCostPer1kTokens}, 0))
      / 2.0 / 1000.0
    , 0) + COALESCE((
      SELECT SUM((${nexusMessages.metadata}->>'estimatedCost')::numeric)
      FROM ${nexusMessages}
      WHERE ${nexusMessages.conversationId} = ${nexusConversations.id}
        AND ${nexusMessages.metadata}->>'estimatedCost' IS NOT NULL
    ), 0)`;

    // Parallel fetch: data + count
    const [items, countResult] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              id: nexusConversations.id,
              userId: nexusConversations.userId,
              userEmail: users.email,
              userName: sql<string>`COALESCE(CONCAT(${users.firstName}, ' ', ${users.lastName}), 'Unknown')`,
              title: nexusConversations.title,
              provider: nexusConversations.provider,
              modelUsed: nexusConversations.modelUsed,
              messageCount: nexusConversations.messageCount,
              totalTokens: nexusConversations.totalTokens,
              costUsd: costSubquery,
              lastMessageAt: nexusConversations.lastMessageAt,
              createdAt: nexusConversations.createdAt,
            })
            .from(nexusConversations)
            .innerJoin(users, eq(nexusConversations.userId, users.id))
            .leftJoin(
              aiModels,
              and(
                eq(nexusConversations.provider, aiModels.provider),
                eq(nexusConversations.modelUsed, aiModels.modelId),
              ),
            )
            .where(whereClause)
            .orderBy(desc(nexusConversations.lastMessageAt))
            .limit(pageSize)
            .offset(offset),
        "getNexusActivity-list",
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(nexusConversations)
            .innerJoin(users, eq(nexusConversations.userId, users.id))
            .where(whereClause),
        "getNexusActivity-count",
      ),
    ]);

    // Parse cost from numeric string to number, handle nullable defaults
    const mappedItems: NexusActivityItem[] = items.map((item) => ({
      ...item,
      userName: item.userName ?? "Unknown",
      messageCount: item.messageCount ?? 0,
      totalTokens: item.totalTokens ?? 0,
      costUsd: Number.parseFloat(String(item.costUsd ?? "0")),
    }));

    timer({ status: "success" });
    log.info("Nexus activity fetched", {
      count: items.length,
      total: countResult[0]?.count ?? 0,
    });

    return createSuccess(
      { items: mappedItems, total: countResult[0]?.count ?? 0 },
      "Activity fetched successfully",
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to fetch Nexus activity", {
      context: "getNexusActivity",
      requestId,
      operation: "getNexusActivity",
    });
  }
}

/**
 * Get messages for a specific conversation
 */
export async function getConversationMessages(
  conversationId: string,
): Promise<ActionState<NexusMessageItem[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("getConversationMessages");
  const log = createLogger({ requestId, action: "getConversationMessages" });

  try {
    log.info("Fetching conversation messages", { conversationId });

    await requireRole("administrator");

    if (!conversationId) {
      throw ErrorFactories.invalidInput(
        "conversationId",
        conversationId,
        "Required",
      );
    }

    // Verify conversation exists
    const conversation = await executeQuery(
      (db) =>
        db
          .select({ id: nexusConversations.id })
          .from(nexusConversations)
          .where(eq(nexusConversations.id, conversationId))
          .limit(1),
      "getConversationMessages-check",
    );

    if (conversation.length === 0) {
      throw ErrorFactories.dbRecordNotFound(
        "nexus_conversations",
        conversationId,
      );
    }

    // Fetch messages
    const messages = await executeQuery(
      (db) =>
        db
          .select({
            id: nexusMessages.id,
            role: nexusMessages.role,
            content: nexusMessages.content,
            tokenUsage: nexusMessages.tokenUsage,
            createdAt: nexusMessages.createdAt,
          })
          .from(nexusMessages)
          .where(eq(nexusMessages.conversationId, conversationId))
          .orderBy(asc(nexusMessages.createdAt)),
      "getConversationMessages-list",
    );

    timer({ status: "success" });
    log.info("Conversation messages fetched", { count: messages.length });

    return createSuccess(
      messages as NexusMessageItem[],
      "Messages fetched successfully",
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to fetch conversation messages", {
      context: "getConversationMessages",
      requestId,
      operation: "getConversationMessages",
    });
  }
}

/**
 * Get paginated assistant architect conversations (manual runs).
 * These are nexus_conversations with provider='assistant-architect'.
 */
export async function getAssistantConversationActivity(
  filters?: ActivityFilters,
): Promise<ActionState<{ items: AssistantConversationItem[]; total: number }>> {
  const requestId = generateRequestId();
  const timer = startTimer("getAssistantConversationActivity");
  const log = createLogger({
    requestId,
    action: "getAssistantConversationActivity",
  });

  try {
    log.info("Fetching assistant conversation activity", {
      filters: sanitizeForLogging(filters),
    });

    await requireRole("administrator");

    const { pageSize, offset } = activityPagination(filters);
    const whereClause = and(
      ...conversationActivityConditions(filters, "assistant"),
    );

    // Token count: use conversation total_tokens, fall back to sum of per-message token data
    const tokenSubquery = sql<number>`CASE
      WHEN ${nexusConversations.totalTokens} > 0 THEN ${nexusConversations.totalTokens}
      ELSE COALESCE((
        SELECT SUM((nm.token_usage->>'totalTokens')::int)
        FROM nexus_messages nm
        WHERE nm.conversation_id = ${nexusConversations.id}
          AND nm.token_usage->>'totalTokens' IS NOT NULL
      ), 0)
    END`;

    // Estimated cost: conversation-level token cost OR per-message token cost with model pricing
    const costSubquery = sql<string>`COALESCE(
      CASE
        WHEN ${nexusConversations.totalTokens} > 0 THEN
          ${nexusConversations.totalTokens}::numeric
          * (COALESCE(${aiModels.inputCostPer1kTokens}, 0) + COALESCE(${aiModels.outputCostPer1kTokens}, 0))
          / 2.0 / 1000.0
        ELSE (
          SELECT SUM(
            (nm.token_usage->>'totalTokens')::numeric
            * (COALESCE(am.input_cost_per_1k_tokens, 0) + COALESCE(am.output_cost_per_1k_tokens, 0))
            / 2.0 / 1000.0
          )
          FROM nexus_messages nm
          LEFT JOIN ai_models am ON nm.model_id = am.id
          WHERE nm.conversation_id = ${nexusConversations.id}
            AND nm.token_usage->>'totalTokens' IS NOT NULL
        )
      END
    , 0) + COALESCE((
      SELECT SUM((${nexusMessages.metadata}->>'estimatedCost')::numeric)
      FROM ${nexusMessages}
      WHERE ${nexusMessages.conversationId} = ${nexusConversations.id}
        AND ${nexusMessages.metadata}->>'estimatedCost' IS NOT NULL
    ), 0)`;

    const [items, countResult] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              id: nexusConversations.id,
              userId: nexusConversations.userId,
              userEmail: users.email,
              userName: sql<string>`COALESCE(CONCAT(${users.firstName}, ' ', ${users.lastName}), 'Unknown')`,
              title: nexusConversations.title,
              assistantName: sql<
                string | null
              >`${nexusConversations.metadata}->>'assistantName'`,
              executionStatus: sql<
                string | null
              >`${nexusConversations.metadata}->>'executionStatus'`,
              modelUsed: sql<string | null>`COALESCE(
                ${nexusConversations.modelUsed},
                (
                  SELECT nm.metadata->'modelRouting'->>'selectedModelId'
                  FROM nexus_messages nm
                  WHERE nm.conversation_id = ${nexusConversations.id}
                    AND nm.metadata->'modelRouting'->>'selectedModelId' IS NOT NULL
                  ORDER BY nm.created_at DESC
                  LIMIT 1
                )
              )`,
              messageCount: nexusConversations.messageCount,
              totalTokens: tokenSubquery,
              costUsd: costSubquery,
              lastMessageAt: nexusConversations.lastMessageAt,
              createdAt: nexusConversations.createdAt,
            })
            .from(nexusConversations)
            .innerJoin(users, eq(nexusConversations.userId, users.id))
            .leftJoin(
              aiModels,
              and(
                eq(nexusConversations.provider, aiModels.provider),
                eq(nexusConversations.modelUsed, aiModels.modelId),
              ),
            )
            .where(whereClause)
            .orderBy(desc(nexusConversations.lastMessageAt))
            .limit(pageSize)
            .offset(offset),
        "getAssistantConversationActivity-list",
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(nexusConversations)
            .innerJoin(users, eq(nexusConversations.userId, users.id))
            .where(whereClause),
        "getAssistantConversationActivity-count",
      ),
    ]);

    const mappedItems: AssistantConversationItem[] = items.map((item) => ({
      ...item,
      userName: item.userName ?? "Unknown",
      messageCount: item.messageCount ?? 0,
      totalTokens: item.totalTokens ?? 0,
      costUsd: Number.parseFloat(String(item.costUsd ?? "0")),
    }));

    timer({ status: "success" });
    log.info("Assistant conversation activity fetched", {
      count: items.length,
      total: countResult[0]?.count ?? 0,
    });

    return createSuccess(
      { items: mappedItems, total: countResult[0]?.count ?? 0 },
      "Activity fetched successfully",
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(
      error,
      "Failed to fetch assistant conversation activity",
      {
        context: "getAssistantConversationActivity",
        requestId,
        operation: "getAssistantConversationActivity",
      },
    );
  }
}

/**
 * Get paginated model comparisons
 */
export async function getComparisonActivity(
  filters?: ActivityFilters,
): Promise<ActionState<{ items: ComparisonActivityItem[]; total: number }>> {
  const requestId = generateRequestId();
  const timer = startTimer("getComparisonActivity");
  const log = createLogger({ requestId, action: "getComparisonActivity" });

  try {
    log.info("Fetching comparison activity", {
      filters: sanitizeForLogging(filters),
    });

    await requireRole("administrator");

    const { pageSize, offset } = activityPagination(filters);
    const conditions = comparisonActivityConditions(filters);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Cost subquery: sum cost for both models using their ai_models pricing
    const comparisonCostSubquery = sql<string>`COALESCE(
      ${modelComparisons.tokensUsed1}::numeric * (
        COALESCE((SELECT am1.input_cost_per_1k_tokens FROM ai_models am1 WHERE am1.id = ${modelComparisons.model1Id}), 0)
        + COALESCE((SELECT am1.output_cost_per_1k_tokens FROM ai_models am1 WHERE am1.id = ${modelComparisons.model1Id}), 0)
      ) / 2.0 / 1000.0
    , 0) + COALESCE(
      ${modelComparisons.tokensUsed2}::numeric * (
        COALESCE((SELECT am2.input_cost_per_1k_tokens FROM ai_models am2 WHERE am2.id = ${modelComparisons.model2Id}), 0)
        + COALESCE((SELECT am2.output_cost_per_1k_tokens FROM ai_models am2 WHERE am2.id = ${modelComparisons.model2Id}), 0)
      ) / 2.0 / 1000.0
    , 0)`;

    const [items, countResult] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              id: modelComparisons.id,
              userId: modelComparisons.userId,
              userName: sql<string>`COALESCE(CONCAT(${users.firstName}, ' ', ${users.lastName}), 'Anonymous')`,
              userEmail: users.email,
              prompt: modelComparisons.prompt,
              model1Name: modelComparisons.model1Name,
              model2Name: modelComparisons.model2Name,
              executionTimeMs1: modelComparisons.executionTimeMs1,
              executionTimeMs2: modelComparisons.executionTimeMs2,
              tokensUsed1: modelComparisons.tokensUsed1,
              tokensUsed2: modelComparisons.tokensUsed2,
              costUsd: comparisonCostSubquery,
              createdAt: modelComparisons.createdAt,
            })
            .from(modelComparisons)
            .leftJoin(users, eq(modelComparisons.userId, users.id))
            .where(whereClause)
            .orderBy(desc(modelComparisons.createdAt))
            .limit(pageSize)
            .offset(offset),
        "getComparisonActivity-list",
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(modelComparisons)
            .leftJoin(users, eq(modelComparisons.userId, users.id))
            .where(whereClause),
        "getComparisonActivity-count",
      ),
    ]);

    // Parse cost from numeric string to number
    const mappedItems: ComparisonActivityItem[] = items.map((item) => ({
      ...item,
      userName: item.userName ?? "Anonymous",
      costUsd: Number.parseFloat(String(item.costUsd ?? "0")),
    }));

    timer({ status: "success" });
    log.info("Comparison activity fetched", {
      count: items.length,
      total: countResult[0]?.count ?? 0,
    });

    return createSuccess(
      { items: mappedItems, total: countResult[0]?.count ?? 0 },
      "Activity fetched successfully",
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to fetch comparison activity", {
      context: "getComparisonActivity",
      requestId,
      operation: "getComparisonActivity",
    });
  }
}

/**
 * Get detailed model comparison
 */
export async function getComparisonDetail(
  comparisonId: number,
): Promise<ActionState<ComparisonDetailItem | null>> {
  const requestId = generateRequestId();
  const timer = startTimer("getComparisonDetail");
  const log = createLogger({ requestId, action: "getComparisonDetail" });

  try {
    log.info("Fetching comparison detail", { comparisonId });

    await requireRole("administrator");

    if (!comparisonId || comparisonId < 1) {
      throw ErrorFactories.invalidInput(
        "comparisonId",
        comparisonId,
        "Must be a positive integer",
      );
    }

    const result = await executeQuery(
      (db) =>
        db
          .select({
            id: modelComparisons.id,
            userId: modelComparisons.userId,
            userName: sql<string>`COALESCE(CONCAT(${users.firstName}, ' ', ${users.lastName}), 'Anonymous')`,
            userEmail: users.email,
            prompt: modelComparisons.prompt,
            model1Name: modelComparisons.model1Name,
            model2Name: modelComparisons.model2Name,
            response1: modelComparisons.response1,
            response2: modelComparisons.response2,
            executionTimeMs1: modelComparisons.executionTimeMs1,
            executionTimeMs2: modelComparisons.executionTimeMs2,
            tokensUsed1: modelComparisons.tokensUsed1,
            tokensUsed2: modelComparisons.tokensUsed2,
            metadata: modelComparisons.metadata,
            createdAt: modelComparisons.createdAt,
          })
          .from(modelComparisons)
          .leftJoin(users, eq(modelComparisons.userId, users.id))
          .where(eq(modelComparisons.id, comparisonId))
          .limit(1),
      "getComparisonDetail",
    );

    if (result.length === 0) {
      throw ErrorFactories.dbRecordNotFound("model_comparisons", comparisonId);
    }

    timer({ status: "success" });
    log.info("Comparison detail fetched", { comparisonId });

    return createSuccess(
      result[0] as ComparisonDetailItem,
      "Detail fetched successfully",
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to fetch comparison detail", {
      context: "getComparisonDetail",
      requestId,
      operation: "getComparisonDetail",
    });
  }
}
