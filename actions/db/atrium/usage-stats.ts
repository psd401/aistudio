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
 * Everything is computed in a handful of grouped queries over one time range
 * (`loadHeadlineRows` + `loadBreakdownRows`) and shaped by small pure
 * helpers; the daily series is zero-filled by `fillDailySeries`.
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
import {
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
  /** ISO start of the range, or null for "all". */
  rangeStart: string | null;
  /** Successful authoring actions in the range. */
  totals: AuthoringCounts & { unpublished: number; deleted: number; collections: number };
  last24h: AuthoringCounts;
  last7d: AuthoringCounts;
  /** Successful mutation events in the range, by who did them. */
  actors: { human: number; agent: number };
  /** Successful mutation events in the range, by the surface they arrived on. */
  surfaces: { ui: number; mcp: number; rest: number };
  /** Distinct human authors with a successful mutation. */
  activeAuthors7d: number;
  activeAuthorsRange: number;
  /** Distinct agent labels with a successful mutation in the range. */
  activeAgentsRange: number;
  /** Mutation attempts that failed in the range. */
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

/** Actions that count as "authoring" for the headline tiles. */
const CREATE = ["create"] as const;
const UPDATE = ["update", "create_version"] as const;
const PUBLISH = ["publish"] as const;
const MUTATIONS = [
  "create",
  "update",
  "create_version",
  "set_visibility",
  "publish",
  "unpublish",
  "delete",
  "collection_create",
  "collection_update",
  "collection_archive",
  "collection_restore",
] as const;
const COLLECTION_ACTIONS = [
  "collection_create",
  "collection_update",
  "collection_archive",
  "collection_restore",
] as const;

const TOP_LIMIT = 15;
const DAILY_MAX_DAYS = 90;

/** `count(*) FILTER (WHERE action IN (...))::int` as a typed SQL fragment. */
function countWhereAction(actions: readonly string[]): SQL<number> {
  return sql<number>`count(*) filter (where ${contentAuditLogs.action} in (${sql.join(
    actions.map((a) => sql`${a}`),
    sql`, `
  )}))::int`;
}

/** `count(*) FILTER (WHERE action IN (...) AND created_at >= since)::int`. */
function countWhereActionSince(actions: readonly string[], since: Date): SQL<number> {
  return sql<number>`count(*) filter (where ${contentAuditLogs.action} in (${sql.join(
    actions.map((a) => sql`${a}`),
    sql`, `
  )}) and ${contentAuditLogs.createdAt} >= ${since})::int`;
}

interface UsageWindow {
  range: AtriumUsageRange;
  rangeStart: Date | null;
  since24h: Date;
  since7d: Date;
  dailyDays: number;
  dailyStart: Date;
}

function usageWindow(range: AtriumUsageRange): UsageWindow {
  const days = RANGE_DAYS[range] ?? 30;
  const dailyDays = days === null ? DAILY_MAX_DAYS : Math.min(days, DAILY_MAX_DAYS);
  return {
    range,
    rangeStart: days === null ? null : getDateThreshold(days),
    since24h: getDateThreshold(1),
    since7d: getDateThreshold(7),
    dailyDays,
    dailyStart: getDateThreshold(dailyDays),
  };
}

/** The WHERE fragments every range-scoped query shares. */
function rangeScope(w: UsageWindow) {
  const l = contentAuditLogs;
  const inRange = w.rangeStart ? gte(l.createdAt, w.rangeStart) : undefined;
  return {
    inRange,
    okInRange: and(eq(l.outcome, "ok"), inRange),
    mutation: inArray(l.action, [...MUTATIONS]),
  };
}

/** Headline counts, actor/surface split, distinct counts, kinds. */
async function loadHeadlineRows(w: UsageWindow) {
  const l = contentAuditLogs;
  const { inRange, okInRange, mutation } = rangeScope(w);
  const [headline, byActorSurface, distinct, kinds] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select({
            created: countWhereAction(CREATE),
            updated: countWhereAction(UPDATE),
            published: countWhereAction(PUBLISH),
            unpublished: countWhereAction(["unpublish"]),
            deleted: countWhereAction(["delete"]),
            collections: countWhereAction(COLLECTION_ACTIONS),
            created24h: countWhereActionSince(CREATE, w.since24h),
            updated24h: countWhereActionSince(UPDATE, w.since24h),
            published24h: countWhereActionSince(PUBLISH, w.since24h),
            created7d: countWhereActionSince(CREATE, w.since7d),
            updated7d: countWhereActionSince(UPDATE, w.since7d),
            published7d: countWhereActionSince(PUBLISH, w.since7d),
          })
          .from(l)
          .where(okInRange),
      "atrium.usage.headline"
    ),
    executeQuery(
      (db) =>
        db
          .select({ actorKind: l.actorKind, surface: l.surface, count: sql<number>`count(*)::int` })
          .from(l)
          .where(and(okInRange, mutation))
          .groupBy(l.actorKind, l.surface),
      "atrium.usage.byActorSurface"
    ),
    executeQuery(
      (db) =>
        db
          .select({
            authors7d: sql<number>`count(distinct ${l.actorUserId}) filter (where ${l.outcome} = 'ok' and ${l.createdAt} >= ${w.since7d})::int`,
            authorsRange: sql<number>`count(distinct ${l.actorUserId}) filter (where ${l.outcome} = 'ok')::int`,
            agentsRange: sql<number>`count(distinct ${l.agentLabel}) filter (where ${l.outcome} = 'ok')::int`,
            errors: sql<number>`count(*) filter (where ${l.outcome} = 'error')::int`,
          })
          .from(l)
          .where(inRange),
      "atrium.usage.distinct"
    ),
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
  ]);
  return { headline, byActorSurface, distinct, kinds };
}

/** Top authors / agents / sections, the daily series, and the inventory. */
async function loadBreakdownRows(w: UsageWindow) {
  const l = contentAuditLogs;
  const { okInRange, mutation } = rangeScope(w);
  const [authors, agents, sections, daily, inventory, collections] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select({
            userId: l.actorUserId,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            created: countWhereAction(CREATE),
            updated: countWhereAction(UPDATE),
            published: countWhereAction(PUBLISH),
            total: sql<number>`count(*)::int`,
          })
          .from(l)
          .innerJoin(users, eq(users.id, l.actorUserId))
          .where(and(okInRange, eq(l.actorKind, "human"), mutation))
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
            created: countWhereAction(CREATE),
            updated: countWhereAction(UPDATE),
            published: countWhereAction(PUBLISH),
            total: sql<number>`count(*)::int`,
          })
          .from(l)
          .where(
            and(okInRange, mutation, sql`(${l.actorKind} = 'agent' or ${l.agentLabel} is not null)`)
          )
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
                 count(*) filter (where ${l.action} = 'create')::int as created,
                 count(*) filter (where ${l.action} in ('update','create_version'))::int as updated,
                 count(*) filter (where ${l.action} = 'publish')::int as published
          from ${l}
          where ${l.outcome} = 'ok' and ${l.createdAt} >= ${w.dailyStart}
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
  return { authors, agents, sections, daily, inventory, collections };
}

type HeadlineRows = Awaited<ReturnType<typeof loadHeadlineRows>>;
type BreakdownRows = Awaited<ReturnType<typeof loadBreakdownRows>>;

function counts(row: { created: number; updated: number; published: number } | undefined): AuthoringCounts {
  return {
    created: Number(row?.created ?? 0),
    updated: Number(row?.updated ?? 0),
    published: Number(row?.published ?? 0),
  };
}

function shapeHeadline(
  rows: HeadlineRows["headline"]
): Pick<AtriumUsageStats, "totals" | "last24h" | "last7d"> {
  const h = rows[0];
  return {
    totals: {
      ...counts(h),
      unpublished: Number(h?.unpublished ?? 0),
      deleted: Number(h?.deleted ?? 0),
      collections: Number(h?.collections ?? 0),
    },
    last24h: counts(h && { created: h.created24h, updated: h.updated24h, published: h.published24h }),
    last7d: counts(h && { created: h.created7d, updated: h.updated7d, published: h.published7d }),
  };
}

function shapeDistinct(
  rows: HeadlineRows["distinct"]
): Pick<AtriumUsageStats, "activeAuthors7d" | "activeAuthorsRange" | "activeAgentsRange" | "errorsRange"> {
  const d = rows[0];
  return {
    activeAuthors7d: Number(d?.authors7d ?? 0),
    activeAuthorsRange: Number(d?.authorsRange ?? 0),
    activeAgentsRange: Number(d?.agentsRange ?? 0),
    errorsRange: Number(d?.errors ?? 0),
  };
}

function shapeActorsAndSurfaces(
  rows: HeadlineRows["byActorSurface"]
): Pick<AtriumUsageStats, "actors" | "surfaces"> {
  const actors = { human: 0, agent: 0 };
  const surfaces = { ui: 0, mcp: 0, rest: 0 };
  for (const row of rows) {
    const n = Number(row.count);
    if (row.actorKind === "agent") actors.agent += n;
    else actors.human += n;
    if (row.surface === "ui" || row.surface === "mcp" || row.surface === "rest") {
      surfaces[row.surface] += n;
    }
  }
  return { actors, surfaces };
}

function shapeKinds(rows: HeadlineRows["kinds"]): AtriumUsageStats["kinds"] {
  const kinds = { document: 0, artifact: 0 };
  for (const row of rows) {
    if (row.kind === "document" || row.kind === "artifact") kinds[row.kind] = Number(row.count);
  }
  return kinds;
}

function shapeInventory(
  rows: BreakdownRows["inventory"],
  collections: BreakdownRows["collections"]
): AtriumUsageStats["inventory"] {
  const inventory = {
    objects: 0,
    published: 0,
    drafts: 0,
    archived: 0,
    collections: Number(collections[0]?.count ?? 0),
  };
  for (const row of rows) {
    const n = Number(row.count);
    inventory.objects += n;
    if (row.status === "published") inventory.published = n;
    else if (row.status === "draft") inventory.drafts = n;
    else if (row.status === "archived") inventory.archived = n;
  }
  return inventory;
}

function displayName(first: string | null, last: string | null, email: string | null, userId: number): string {
  const name = `${first ?? ""} ${last ?? ""}`.trim();
  return name || email || `User #${userId}`;
}

function shapeAuthors(rows: BreakdownRows["authors"]): AtriumUsageAuthor[] {
  const out: AtriumUsageAuthor[] = [];
  for (const row of rows) {
    if (row.userId == null) continue;
    out.push({
      userId: row.userId,
      name: displayName(row.firstName, row.lastName, row.email, row.userId),
      email: row.email,
      ...counts(row),
      total: Number(row.total),
    });
  }
  return out;
}

function shapeAgents(rows: BreakdownRows["agents"]): AtriumUsageAgent[] {
  return rows.map((row) => ({
    label: row.label ?? "Agent",
    ...counts(row),
    total: Number(row.total),
  }));
}

function shapeSections(rows: BreakdownRows["sections"]): AtriumUsageSection[] {
  return rows.map((row) => ({
    collectionId: row.collectionId,
    name: row.name,
    total: Number(row.total),
  }));
}

function shapeDaily(rows: BreakdownRows["daily"], days: number): DailyActivityPoint[] {
  return fillDailySeries(
    toPgRows<DailyActivityPoint>(rows).map((row) => ({
      day: String(row.day),
      created: Number(row.created),
      updated: Number(row.updated),
      published: Number(row.published),
    })),
    days
  );
}

function shapeUsageStats(w: UsageWindow, head: HeadlineRows, more: BreakdownRows): AtriumUsageStats {
  return {
    range: w.range,
    rangeStart: w.rangeStart ? w.rangeStart.toISOString() : null,
    ...shapeHeadline(head.headline),
    ...shapeActorsAndSurfaces(head.byActorSurface),
    ...shapeDistinct(head.distinct),
    kinds: shapeKinds(head.kinds),
    topAuthors: shapeAuthors(more.authors),
    topAgents: shapeAgents(more.agents),
    topSections: shapeSections(more.sections),
    daily: shapeDaily(more.daily, w.dailyDays),
    inventory: shapeInventory(more.inventory, more.collections),
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
    const requester = await getUserRequester(requestId);
    if (requester.kind !== "user" || !requester.isAdmin) {
      throw ErrorFactories.authzAdminRequired("getAtriumUsageStats");
    }
    const window = usageWindow(range);
    const [head, more] = await Promise.all([
      loadHeadlineRows(window),
      loadBreakdownRows(window),
    ]);
    const data = shapeUsageStats(window, head, more);

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
