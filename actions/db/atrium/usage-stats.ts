"use server";

/**
 * Atrium usage dashboard server action — administrator-only aggregate view of
 * how the district is using Atrium.
 *
 * Source of truth is `content_audit_logs` (migration 090), the append-only
 * trail every content mutation writes: who (human / agent), what action, on
 * which object, via which surface. It is MUTATION-only — there is no
 * read/view event anywhere in the schema — so this dashboard answers "who is
 * authoring, publishing and organizing, and where", not "who is reading".
 * Audit writes are best-effort, so the numbers are operational, not
 * compliance-grade.
 *
 * One range-scoped pass over the trail (`loadHeadline`, a single SELECT of
 * FILTER-ed aggregates) plus a handful of grouped breakdowns
 * (`loadBreakdown`); the daily series is zero-filled by `fillDailySeries`.
 *
 * Every predicate is composed from Drizzle operators (`inArray`, `gte`, …)
 * rather than interpolated raw: a bare `${date}` inside a `sql` template
 * reaches postgres.js unserialized and fails the whole query.
 */

import { and, desc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client";
import {
  contentAuditLogs,
  contentCollections,
  contentObjects,
  users,
} from "@/lib/db/schema";
import { getDateThreshold } from "@/lib/date-utils";
import { ValidationError } from "@/lib/content";
import type { ContentAuditAction, ContentAuditSurface } from "@/lib/content/audit";
import {
  dailyWindowStart,
  fillDailySeries,
  type DailyActivityPoint,
} from "@/lib/atrium/usage-series";
import type { ActionState } from "@/types";
import { getUserRequester } from "./requester";

export type AtriumUsageRange = "7d" | "30d" | "90d" | "all";

/** Counts of the three headline authoring actions. */
export interface AuthoringCounts {
  created: number;
  updated: number;
  published: number;
}

export interface AtriumUsageAuthor extends AuthoringCounts {
  userId: number;
  name: string;
  email: string | null;
  total: number;
}

export interface AtriumUsageAgent extends AuthoringCounts {
  label: string;
  total: number;
}

export interface AtriumUsageSection {
  collectionId: string;
  name: string;
  total: number;
}

export interface AtriumUsageStats {
  range: AtriumUsageRange;
  /** Successful authoring actions in the range. */
  totals: AuthoringCounts & { unpublished: number; deleted: number; collections: number };
  last24h: AuthoringCounts;
  last7d: AuthoringCounts;
  /** Successful audited actions in the range, by who did them. */
  actors: { human: number; agent: number };
  /** Successful audited actions in the range, by the surface they arrived on. */
  surfaces: Record<ContentAuditSurface, number>;
  /** Distinct human authors with a successful action. */
  activeAuthors7d: number;
  activeAuthorsRange: number;
  /** Distinct agent labels with a successful action in the range. */
  activeAgentsRange: number;
  /** Audited attempts that failed in the range. */
  errorsRange: number;
  /** Objects touched in the range, by kind. */
  kinds: { document: number; artifact: number };
  topAuthors: AtriumUsageAuthor[];
  topAgents: AtriumUsageAgent[];
  topSections: AtriumUsageSection[];
  /** One point per day for the range window (capped at 90 days; "all" shows 90). */
  daily: DailyActivityPoint[];
  /** Current inventory, independent of the range. */
  inventory: {
    objects: number;
    published: number;
    drafts: number;
    archived: number;
    collections: number;
  };
}

const RANGE_DAYS: Record<AtriumUsageRange, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};
const USAGE_RANGES = Object.keys(RANGE_DAYS) as AtriumUsageRange[];

/** The range arrives over the server-action RPC boundary; the TS type is not enforced there. */
function isUsageRange(value: unknown): value is AtriumUsageRange {
  return typeof value === "string" && (USAGE_RANGES as string[]).includes(value);
}

/**
 * How every audited action rolls up into the headline tiles. `satisfies`
 * makes a new `ContentAuditAction` member a COMPILE error here rather than an
 * action silently missing from the dashboard.
 */
const ACTION_CLASS = {
  create: "create",
  update: "update",
  create_version: "update",
  set_visibility: "other",
  publish: "publish",
  unpublish: "unpublish",
  delete: "delete",
  export_okf: "other",
  import_okf: "other",
  initiate_asset: "other",
  complete_asset: "other",
  collection_create: "collection",
  collection_update: "collection",
  collection_archive: "collection",
  collection_restore: "collection",
} as const satisfies Record<
  ContentAuditAction,
  "create" | "update" | "publish" | "unpublish" | "delete" | "collection" | "other"
>;
type ActionClass = (typeof ACTION_CLASS)[ContentAuditAction];

function actionsOf(cls: ActionClass): ContentAuditAction[] {
  return (Object.keys(ACTION_CLASS) as ContentAuditAction[]).filter(
    (action) => ACTION_CLASS[action] === cls
  );
}
const CREATE = actionsOf("create");
const UPDATE = actionsOf("update");
const PUBLISH = actionsOf("publish");
const UNPUBLISH = actionsOf("unpublish");
const DELETE = actionsOf("delete");
const COLLECTION = actionsOf("collection");

const TOP_LIMIT = 15;
const DAILY_MAX_DAYS = 90;

const l = contentAuditLogs;
const ok = eq(l.outcome, "ok");
/**
 * "An agent did it": autonomous agents are `actor_kind = 'agent'`, but a
 * DELEGATED agent (acting on a person's key) is audited as `human` WITH an
 * `agent_label` (lib/content/helpers.ts `actorKindOf`). The agent-activity feed
 * already treats the label as the signal; every tile here uses the same rule so
 * "Agent share", "Most active agents" and "Active authors" agree with each other.
 */
const byAgent = sql`(${l.actorKind} = 'agent' or ${l.agentLabel} is not null)`;
const byPerson = sql`(${l.actorKind} = 'human' and ${l.agentLabel} is null)`;

/** `count(*) FILTER (WHERE cond)::int`. */
function countIf(cond: SQL): SQL<number> {
  return sql<number>`count(*) filter (where ${cond})::int`;
}

/** A successful action of one class, optionally since a date. */
function okAction(actions: ContentAuditAction[], since?: Date): SQL {
  return since
    ? sql`${ok} and ${inArray(l.action, actions)} and ${gte(l.createdAt, since)}`
    : sql`${ok} and ${inArray(l.action, actions)}`;
}

interface UsageWindow {
  range: AtriumUsageRange;
  /** Range predicate on created_at, or undefined for "all". */
  inRange: SQL | undefined;
  since24h: Date;
  since7d: Date;
  dailyDays: number;
  dailyStart: Date;
}

function usageWindow(range: AtriumUsageRange): UsageWindow {
  const days = RANGE_DAYS[range];
  const dailyDays = days === null ? DAILY_MAX_DAYS : Math.min(days, DAILY_MAX_DAYS);
  return {
    range,
    inRange: days === null ? undefined : gte(l.createdAt, getDateThreshold(days)),
    since24h: getDateThreshold(1),
    since7d: getDateThreshold(7),
    dailyDays,
    // A calendar-day boundary, so the strip's first day is whole (the tiles'
    // rolling ranges are deliberately different windows and say so).
    dailyStart: dailyWindowStart(dailyDays),
  };
}

type Headline = Pick<
  AtriumUsageStats,
  | "totals"
  | "last24h"
  | "last7d"
  | "actors"
  | "surfaces"
  | "activeAuthors7d"
  | "activeAuthorsRange"
  | "activeAgentsRange"
  | "errorsRange"
>;

/** Every headline number in ONE pass over the range's audit rows. */
async function loadHeadline(w: UsageWindow): Promise<Headline> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          created: countIf(okAction(CREATE)),
          updated: countIf(okAction(UPDATE)),
          published: countIf(okAction(PUBLISH)),
          unpublished: countIf(okAction(UNPUBLISH)),
          deleted: countIf(okAction(DELETE)),
          collections: countIf(okAction(COLLECTION)),
          created24h: countIf(okAction(CREATE, w.since24h)),
          updated24h: countIf(okAction(UPDATE, w.since24h)),
          published24h: countIf(okAction(PUBLISH, w.since24h)),
          created7d: countIf(okAction(CREATE, w.since7d)),
          updated7d: countIf(okAction(UPDATE, w.since7d)),
          published7d: countIf(okAction(PUBLISH, w.since7d)),
          human: countIf(sql`${ok} and ${byPerson}`),
          agent: countIf(sql`${ok} and ${byAgent}`),
          ui: countIf(sql`${ok} and ${eq(l.surface, "ui")}`),
          mcp: countIf(sql`${ok} and ${eq(l.surface, "mcp")}`),
          rest: countIf(sql`${ok} and ${eq(l.surface, "rest")}`),
          authors7d: sql<number>`count(distinct ${l.actorUserId}) filter (where ${ok} and ${byPerson} and ${gte(l.createdAt, w.since7d)})::int`,
          authorsRange: sql<number>`count(distinct ${l.actorUserId}) filter (where ${ok} and ${byPerson})::int`,
          agentsRange: sql<number>`count(distinct ${l.agentLabel}) filter (where ${ok} and ${byAgent})::int`,
          errors: countIf(eq(l.outcome, "error")),
        })
        .from(l)
        .where(w.inRange),
    "atrium.usage.headline"
  );
  // An ungrouped aggregate always yields exactly one row.
  const [h] = rows;
  return {
    totals: {
      created: h.created,
      updated: h.updated,
      published: h.published,
      unpublished: h.unpublished,
      deleted: h.deleted,
      collections: h.collections,
    },
    last24h: { created: h.created24h, updated: h.updated24h, published: h.published24h },
    last7d: { created: h.created7d, updated: h.updated7d, published: h.published7d },
    actors: { human: h.human, agent: h.agent },
    surfaces: { ui: h.ui, mcp: h.mcp, rest: h.rest },
    activeAuthors7d: h.authors7d,
    activeAuthorsRange: h.authorsRange,
    activeAgentsRange: h.agentsRange,
    errorsRange: h.errors,
  };
}

type Breakdown = Pick<
  AtriumUsageStats,
  "kinds" | "topAuthors" | "topAgents" | "topSections" | "daily" | "inventory"
>;

function displayName(first: string | null, last: string | null, email: string | null, userId: number): string {
  const name = `${first ?? ""} ${last ?? ""}`.trim();
  return name || email || `User #${userId}`;
}

/** Kinds, top authors / agents / sections, the daily series, and the inventory. */
async function loadBreakdown(w: UsageWindow): Promise<Breakdown> {
  const okInRange = and(ok, w.inRange);
  const [kindRows, authorRows, agentRows, sectionRows, dailyRows, inventoryRows, collectionRows] =
    await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({ kind: contentObjects.kind, count: sql<number>`count(distinct ${l.objectId})::int` })
            .from(l)
            .innerJoin(contentObjects, eq(contentObjects.id, l.objectId))
            .where(okInRange)
            .groupBy(contentObjects.kind),
        "atrium.usage.kinds"
      ),
      executeQuery(
        (db) =>
          db
            .select({
              userId: l.actorUserId,
              firstName: users.firstName,
              lastName: users.lastName,
              email: users.email,
              created: countIf(inArray(l.action, CREATE)),
              updated: countIf(inArray(l.action, UPDATE)),
              published: countIf(inArray(l.action, PUBLISH)),
              total: sql<number>`count(*)::int`,
            })
            .from(l)
            .innerJoin(users, eq(users.id, l.actorUserId))
            .where(and(okInRange, byPerson))
            .groupBy(l.actorUserId, users.firstName, users.lastName, users.email)
            .orderBy(desc(sql`count(*)`))
            .limit(TOP_LIMIT),
        "atrium.usage.topAuthors"
      ),
      executeQuery(
        (db) =>
          db
            .select({
              label: l.agentLabel,
              created: countIf(inArray(l.action, CREATE)),
              updated: countIf(inArray(l.action, UPDATE)),
              published: countIf(inArray(l.action, PUBLISH)),
              total: sql<number>`count(*)::int`,
            })
            .from(l)
            .where(and(okInRange, byAgent))
            .groupBy(l.agentLabel)
            .orderBy(desc(sql`count(*)`))
            .limit(TOP_LIMIT),
        "atrium.usage.topAgents"
      ),
      executeQuery(
        (db) =>
          db
            .select({
              collectionId: contentCollections.id,
              name: contentCollections.name,
              total: sql<number>`count(*)::int`,
            })
            .from(l)
            .innerJoin(contentObjects, eq(contentObjects.id, l.objectId))
            .innerJoin(contentCollections, eq(contentCollections.id, contentObjects.collectionId))
            .where(okInRange)
            .groupBy(contentCollections.id, contentCollections.name)
            .orderBy(desc(sql`count(*)`))
            .limit(10),
        "atrium.usage.topSections"
      ),
      executeQuery(
        (db) =>
          db.execute(sql`
            select to_char(date_trunc('day', ${l.createdAt}), 'YYYY-MM-DD') as day,
                   ${countIf(inArray(l.action, CREATE))} as created,
                   ${countIf(inArray(l.action, UPDATE))} as updated,
                   ${countIf(inArray(l.action, PUBLISH))} as published
            from ${l}
            where ${ok} and ${gte(l.createdAt, w.dailyStart)}
            group by 1
          `),
        "atrium.usage.daily"
      ),
      executeQuery(
        (db) =>
          db
            .select({ status: contentObjects.status, count: sql<number>`count(*)::int` })
            .from(contentObjects)
            .groupBy(contentObjects.status),
        "atrium.usage.inventory"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(contentCollections)
            .where(isNull(contentCollections.archivedAt)),
        "atrium.usage.collections"
      ),
    ]);

  const kinds = { document: 0, artifact: 0 };
  for (const row of kindRows) kinds[row.kind] = row.count;

  const inventory = {
    objects: 0,
    published: 0,
    drafts: 0,
    archived: 0,
    collections: collectionRows[0]?.count ?? 0,
  };
  for (const row of inventoryRows) {
    inventory.objects += row.count;
    if (row.status === "published") inventory.published = row.count;
    else if (row.status === "draft") inventory.drafts = row.count;
    else if (row.status === "archived") inventory.archived = row.count;
  }

  const topAuthors: AtriumUsageAuthor[] = [];
  for (const row of authorRows) {
    if (row.userId == null) continue;
    topAuthors.push({
      userId: row.userId,
      name: displayName(row.firstName, row.lastName, row.email, row.userId),
      email: row.email,
      created: row.created,
      updated: row.updated,
      published: row.published,
      total: row.total,
    });
  }

  return {
    kinds,
    topAuthors,
    topAgents: agentRows.map((row) => ({ ...row, label: row.label ?? "Agent" })),
    topSections: sectionRows,
    daily: fillDailySeries(toPgRows<DailyActivityPoint>(dailyRows), w.dailyDays),
    inventory,
  };
}

/**
 * Aggregate Atrium usage for a range (administrators only).
 */
export async function getAtriumUsageStatsAction(
  range: AtriumUsageRange = "30d"
): Promise<ActionState<AtriumUsageStats>> {
  const requestId = generateRequestId();
  const timer = startTimer("getAtriumUsageStatsAction");
  const log = createLogger({ requestId, action: "getAtriumUsageStatsAction" });

  try {
    log.info("Action started: Atrium usage stats", { range });
    const requester = await getUserRequester(requestId);
    if (requester.kind !== "user" || !requester.isAdmin) {
      throw ErrorFactories.authzAdminRequired("getAtriumUsageStats");
    }
    if (!isUsageRange(range)) {
      throw new ValidationError("Unknown usage range", { range });
    }
    const window = usageWindow(range);
    const [headline, breakdown] = await Promise.all([
      loadHeadline(window),
      loadBreakdown(window),
    ]);
    const data: AtriumUsageStats = { range, ...headline, ...breakdown };

    timer({ status: "success" });
    log.info("Atrium usage stats computed", {
      range,
      created: data.totals.created,
      authors: data.activeAuthorsRange,
    });
    return createSuccess(data, "Usage stats loaded");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load Atrium usage", {
      context: "getAtriumUsageStatsAction",
      requestId,
      operation: "getAtriumUsageStatsAction",
    });
  }
}
