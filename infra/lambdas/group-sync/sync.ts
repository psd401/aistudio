/**
 * Group-sync reconciliation core (Epic #1202, Phase 0 / #1203).
 *
 * The dependency-injected heart of the hourly Google Directory sync — kept free
 * of AWS/Google/DB SDK imports so the fail-safety and reconciliation invariants
 * are unit-testable in isolation (see sync.test.ts). index.ts wires the real
 * Google client, postgres.js writer, and CloudWatch metrics into these ports.
 *
 * Invariants enforced here:
 *   - Selection: active 'pick' rules are ALWAYS selected (a hand-pick is
 *     authoritative and must survive a flaky directory listing); active 'prefix'
 *     rules select the directory groups whose email startsWith the prefix. A pick
 *     wins over a prefix on a tie (source = 'manual').
 *   - Fail-safety: a group whose member fetch throws keeps its last-known-good
 *     membership — replaceMembers is NEVER called for it, only markError. One
 *     group's failure never aborts the others (partial sync, never mass-revoke).
 *     Metadata writes (markSynced/markError) are their own failure domain: they
 *     are best-effort and can neither mislabel a fresh membership as failed nor
 *     abort the loop for the remaining groups.
 *   - Normalization: every member email is lowercased + trimmed + de-duplicated
 *     before it is written (Google emails are case-insensitive; email is an
 *     authorization join key).
 *   - Deactivation is selection-driven, and only runs after a SUCCESSFUL
 *     directory listing — a group that falls out of the selection is flipped
 *     is_active=false (never hard-deleted, so membership survives), while picks
 *     can never spuriously deactivate.
 */

import { normalizeEmail } from "./normalize";

/** How a group entered the selection. A hand-pick wins over a prefix match. */
export type GroupSource = "manual" | "prefix";

/** A selection rule as stored in group_selection_rules (only what matters here). */
export interface SelectionRule {
  ruleType: "pick" | "prefix";
  value: string;
  isActive: boolean;
}

/** A group as seen in the live directory listing. */
export interface DirectoryGroup {
  email: string;
  name: string | null;
}

/** A resolved selection entry: the group to sync and how it was selected. */
export interface SelectedGroup {
  email: string;
  name: string | null;
  source: GroupSource;
}

/**
 * Lowercase + trim + de-duplicate a list of member emails, dropping empties.
 * Order is preserved (first occurrence wins) for stable, diffable writes.
 */
export function dedupeNormalizedEmails(emails: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * Resolve the groups to sync from the active rules and the live directory
 * listing. Picks are always included (authoritative, source 'manual'); prefixes
 * select matching directory groups (source 'prefix'). A pick wins over a prefix
 * on a tie. Empty pick/prefix values are ignored (an empty prefix would select
 * every group — never the intent, and an authorization footgun).
 *
 * Pure: no I/O. The directory listing is the caller's responsibility; if it
 * failed, the caller must NOT call this with an empty list and then deactivate.
 */
export function resolveSelectedGroups(
  rules: SelectionRule[],
  directoryGroups: DirectoryGroup[]
): SelectedGroup[] {
  const pickEmails = new Set<string>();
  const prefixes: string[] = [];
  for (const rule of rules) {
    if (!rule.isActive) continue;
    const value = normalizeEmail(rule.value);
    if (!value) continue;
    if (rule.ruleType === "pick") pickEmails.add(value);
    else prefixes.push(value);
  }

  // Directory name lookup (normalized email → display name) for enriching picks.
  const nameByEmail = new Map<string, string | null>();
  for (const g of directoryGroups) {
    const email = normalizeEmail(g.email);
    if (email) nameByEmail.set(email, g.name);
  }

  const selected = new Map<string, SelectedGroup>();

  // Picks first — always selected, and they win the source on a tie.
  for (const email of pickEmails) {
    selected.set(email, { email, name: nameByEmail.get(email) ?? null, source: "manual" });
  }

  // Prefix matches from the directory listing (skip anything already a pick).
  if (prefixes.length > 0) {
    for (const g of directoryGroups) {
      const email = normalizeEmail(g.email);
      if (!email || selected.has(email)) continue;
      if (prefixes.some((prefix) => email.startsWith(prefix))) {
        selected.set(email, { email, name: g.name, source: "prefix" });
      }
    }
  }

  return [...selected.values()];
}

/**
 * A raw directory membership node — a member is either a person (has an email)
 * or a nested group (has a groupEmail whose members must be expanded). Mirrors
 * both the Cloud Identity and Admin SDK member shapes after mapping.
 */
export interface RawMember {
  email: string | null;
  /** Present when this member is itself a group (Admin SDK type=GROUP). */
  nestedGroupEmail?: string | null;
}

/**
 * Flatten a group's membership transitively for directory APIs that only return
 * DIRECT members (Admin SDK Directory `members.list`). Recurses into nested
 * groups via `fetchDirect`, guarding against cycles. Cloud Identity's
 * searchTransitiveMemberships already returns the flattened set, so that path
 * does not need this.
 *
 * Returns normalized, de-duplicated person emails only.
 */
export async function flattenTransitiveMembers(
  rootGroupEmail: string,
  fetchDirect: (groupEmail: string) => Promise<RawMember[]>
): Promise<string[]> {
  const personEmails = new Set<string>();
  const visitedGroups = new Set<string>();

  const walk = async (groupEmail: string): Promise<void> => {
    const key = normalizeEmail(groupEmail);
    if (!key || visitedGroups.has(key)) return;
    visitedGroups.add(key);

    const members = await fetchDirect(groupEmail);
    for (const m of members) {
      const nested = normalizeEmail(m.nestedGroupEmail);
      if (nested) {
        await walk(nested);
        continue;
      }
      const email = normalizeEmail(m.email);
      if (email) personEmails.add(email);
    }
  };

  await walk(rootGroupEmail);
  return [...personEmails];
}

/** The DB + directory + observability ports the reconciler drives. */
export interface GroupSyncPorts {
  /** Active selection rules (picks ∪ prefixes). */
  listActiveRules(): Promise<SelectionRule[]>;
  /** Every group visible in the directory — the universe for prefix matching. */
  listDirectoryGroups(): Promise<DirectoryGroup[]>;
  /** Transitive (flattened) member emails for one group. Throws on API failure. */
  fetchTransitiveMembers(groupEmail: string): Promise<string[]>;
  /** Upsert the group row (is_active=true, name/source refreshed); return its id. */
  upsertGroup(input: { groupEmail: string; name: string | null; source: GroupSource }): Promise<string>;
  /** Full-replace a group's membership inside a transaction. */
  replaceMembers(groupId: string, memberEmails: string[]): Promise<void>;
  /** Record a successful fetch (last_synced_at=now, last_sync_error=null). */
  markSynced(groupId: string): Promise<void>;
  /** Record a failed fetch (last_sync_error set, last_synced_at untouched). */
  markError(groupId: string, message: string): Promise<void>;
  /** Flip is_active=false for active groups whose email is not in the set. */
  deactivateGroupsNotIn(selectedEmails: string[]): Promise<number>;
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface GroupSyncResult {
  selected: number;
  synced: number;
  failed: number;
  deactivated: number;
  totalMembers: number;
}

/**
 * Run one full sync pass. Resolves the selection, deactivates groups that fell
 * out of it, then per group: upsert → fetch transitive members → full-replace →
 * mark synced. A per-group fetch failure marks the error and preserves that
 * group's last-known-good membership without touching the rest.
 *
 * A failure of listDirectoryGroups() (whole-directory outage) propagates and
 * aborts BEFORE any deactivation or membership write — the top-level guarantee
 * against a mass-revoke.
 */
export async function runGroupSync(ports: GroupSyncPorts): Promise<GroupSyncResult> {
  const rules = await ports.listActiveRules();
  // If this throws, we abort here: nothing is deactivated, no membership touched.
  const directoryGroups = await ports.listDirectoryGroups();

  const selected = resolveSelectedGroups(rules, directoryGroups);
  const selectedEmails = selected.map((s) => s.email);

  // Deactivation guard (issue #1203: "partial sync must never mass-revoke").
  // An admin removing rules still leaves a NON-EMPTY directory, so a genuinely
  // empty listing is almost certainly a silent API failure — skip deactivation
  // rather than flip every prefix-matched group inactive. Picks are unaffected
  // either way (they are always selected). A non-empty listing lets legitimate
  // de-selection proceed.
  let deactivated = 0;
  if (directoryGroups.length > 0) {
    deactivated = await ports.deactivateGroupsNotIn(selectedEmails);
    if (deactivated > 0) {
      ports.log.info("Deactivated groups no longer selected", { count: deactivated });
    }
  } else {
    ports.log.warn("Directory listing returned zero groups — skipping deactivation (fail-safe)");
  }

  let synced = 0;
  let failed = 0;
  let totalMembers = 0;

  for (const group of selected) {
    let groupId: string;
    try {
      groupId = await ports.upsertGroup({
        groupEmail: group.email,
        name: group.name,
        source: group.source,
      });
    } catch (error) {
      failed += 1;
      ports.log.error("Failed to upsert group row", {
        groupEmail: group.email,
        error: errorMessage(error),
      });
      continue;
    }

    try {
      const rawMembers = await ports.fetchTransitiveMembers(group.email);
      const members = dedupeNormalizedEmails(rawMembers);
      await ports.replaceMembers(groupId, members);
      synced += 1;
      totalMembers += members.length;
      // Separate failure domain: membership is already committed and fresh, so
      // a markSynced hiccup must NOT route through markError (which would
      // mislabel the group as failed in the admin UI / GroupsFailed metric).
      // last_synced_at self-heals on the next successful run.
      try {
        await ports.markSynced(groupId);
      } catch (metaError) {
        ports.log.warn("markSynced failed after a successful membership write", {
          groupEmail: group.email,
          error: errorMessage(metaError),
        });
      }
      ports.log.info("Synced group membership", {
        groupEmail: group.email,
        source: group.source,
        memberCount: members.length,
      });
    } catch (error) {
      // Fail-safety: DO NOT touch membership — last-known-good survives.
      failed += 1;
      const message = errorMessage(error);
      // markError is best-effort: a metadata-write failure must never abort the
      // loop and starve every group after this one.
      try {
        await ports.markError(groupId, message);
      } catch (metaError) {
        ports.log.error("markError failed; continuing with remaining groups", {
          groupEmail: group.email,
          error: errorMessage(metaError),
        });
      }
      ports.log.warn("Group fetch failed; keeping last-known-good membership", {
        groupEmail: group.email,
        error: message,
      });
    }
  }

  return { selected: selected.length, synced, failed, deactivated, totalMembers };
}

/** Extract a safe, bounded message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
}
