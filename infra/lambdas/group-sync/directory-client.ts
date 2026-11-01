/**
 * Google Directory client for the group-sync Lambda (Epic #1202, Phase 0 / #1203).
 *
 * Reads through the Cloud Identity API as the district's shared, keyless
 * groups reader (directory-auth.ts, #1989), a service account holding the
 * built-in Groups Reader admin role directly (no domain-wide delegation). Uses
 * groups.list to enumerate the customer's groups and
 * memberships.searchTransitiveMemberships to read already-flattened
 * membership. Requires the Cloud Identity customer id (Cxxxxxxx).
 *
 * The earlier Admin SDK path (domain-wide delegation impersonating an admin)
 * was removed in #1989: no environment used it, and a keyless version would
 * have needed signJwt on the reader.
 *
 * Returns normalized, de-duplicated person emails. The client caches the set
 * of known directory-group emails so it can drop nested-group entities (which
 * searchTransitiveMemberships also returns) and keep only people.
 */

import { cloudidentity, type cloudidentity_v1 } from "@googleapis/cloudidentity";
import { normalizeEmail } from "./normalize";
import type { DirectoryGroup } from "./sync";
import type { GroupSyncConfig } from "./config";
import type { DirectoryAuth } from "./directory-auth";

const LIST_PAGE_SIZE = 500;
const MEMBER_PAGE_SIZE = 200;

/** The read surface the reconciler drives (see sync.ts GroupSyncPorts). */
export interface DirectoryClient {
  /** Every group visible in the directory (for prefix matching). */
  listGroups(): Promise<DirectoryGroup[]>;
  /** Transitive, flattened, normalized person emails for one group. */
  fetchTransitiveMembers(groupEmail: string): Promise<string[]>;
}

/** Build the Cloud Identity directory client. */
export function createDirectoryClient(
  authClient: DirectoryAuth,
  config: GroupSyncConfig
): DirectoryClient {
  return new CloudIdentityDirectoryClient(authClient, config);
}

class CloudIdentityDirectoryClient implements DirectoryClient {
  private readonly api: cloudidentity_v1.Cloudidentity;
  private readonly parent: string;
  /** Lowercased set of known directory-group emails, populated by listGroups(). */
  private groupEmailSet = new Set<string>();

  constructor(authClient: DirectoryAuth, config: GroupSyncConfig) {
    if (!config.customerId) {
      throw new Error(
        "GOOGLE_DIRECTORY_CUSTOMER_ID is required (e.g. Cxxxxxxx). Set it in Admin → Settings."
      );
    }
    this.api = cloudidentity({ version: "v1", auth: authClient });
    this.parent = `customers/${config.customerId}`;
  }

  async listGroups(): Promise<DirectoryGroup[]> {
    const out: DirectoryGroup[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.api.groups.list({
        parent: this.parent,
        view: "BASIC",
        pageSize: LIST_PAGE_SIZE,
        pageToken,
      });
      for (const g of res.data.groups ?? []) {
        const email = normalizeEmail(g.groupKey?.id);
        if (!email) continue;
        this.groupEmailSet.add(email);
        out.push({ email, name: g.displayName ?? null });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async fetchTransitiveMembers(groupEmail: string): Promise<string[]> {
    // groupEmailSet is populated by listGroups(). Empty means the listing was
    // never run OR came back empty/degraded (a non-throwing API glitch). Without
    // it we cannot distinguish nested-group entities from people, so fail THIS
    // group loudly — the reconciler's per-group catch keeps last-known-good
    // membership — rather than silently write group addresses into
    // group_members (an authorization join table) as if they were people.
    if (this.groupEmailSet.size === 0) {
      throw new Error(
        "Directory group listing is empty — cannot classify nested groups; " +
          "call listGroups() first / retry next run"
      );
    }
    const resourceName = await this.lookupResourceName(groupEmail);
    const emails = new Set<string>();
    let pageToken: string | undefined;
    do {
      const res = await this.api.groups.memberships.searchTransitiveMemberships({
        parent: resourceName,
        pageSize: MEMBER_PAGE_SIZE,
        pageToken,
      });
      for (const membership of res.data.memberships ?? []) {
        for (const memberKey of membership.preferredMemberKey ?? []) {
          const email = normalizeEmail(memberKey.id);
          // Skip nested-group entities — searchTransitiveMemberships returns the
          // nested groups themselves alongside the flattened users. A known
          // directory-group email is a group, not a person.
          if (email && !this.groupEmailSet.has(email)) emails.add(email);
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return [...emails];
  }

  private async lookupResourceName(groupEmail: string): Promise<string> {
    const res = await this.api.groups.lookup({ "groupKey.id": normalizeEmail(groupEmail) });
    const name = res.data.name;
    if (!name) throw new Error(`Group not found in Cloud Identity: ${groupEmail}`);
    return name;
  }
}

