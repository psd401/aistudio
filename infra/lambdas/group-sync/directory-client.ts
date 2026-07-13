/**
 * Google Directory client for the group-sync Lambda (Epic #1202, Phase 0 / #1203).
 *
 * Two interchangeable read paths, chosen by config (Phase-0 spike outcome):
 *
 *   - Cloud Identity API (default): a service account holding the built-in
 *     Groups Reader admin role directly (no domain-wide delegation). Uses
 *     groups.list to enumerate the customer's groups and
 *     memberships.searchTransitiveMemberships to read already-flattened
 *     membership. Requires the Cloud Identity customer id (Cxxxxxxx).
 *
 *   - Admin SDK Directory API (when a DWD subject is configured): the SA
 *     impersonates an admin (domain-wide delegation) and reads groups.list +
 *     members.list. members.list returns DIRECT members only, so nested groups
 *     are flattened here via the shared, unit-tested flattenTransitiveMembers
 *     (recurses type=GROUP members, cycle-guarded).
 *
 * Both return normalized, de-duplicated person emails. The client caches the set
 * of known directory-group emails so the Cloud Identity path can drop nested-group
 * entities (which searchTransitiveMemberships also returns) and keep only people.
 */

import { cloudidentity, auth as cloudIdentityAuth, type cloudidentity_v1 } from "@googleapis/cloudidentity";
import { admin, auth as adminAuth, type admin_directory_v1 } from "@googleapis/admin";
import { normalizeEmail } from "./normalize";
import { flattenTransitiveMembers, type RawMember, type DirectoryGroup } from "./sync";
import type { GroupSyncConfig, ServiceAccountKey } from "./config";

const CLOUD_IDENTITY_SCOPES = ["https://www.googleapis.com/auth/cloud-identity.groups.readonly"];
const ADMIN_SDK_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
];

const LIST_PAGE_SIZE = 500;
const MEMBER_PAGE_SIZE = 200;

/** The read surface the reconciler drives (see sync.ts GroupSyncPorts). */
export interface DirectoryClient {
  /** Every group visible in the directory (for prefix matching). */
  listGroups(): Promise<DirectoryGroup[]>;
  /** Transitive, flattened, normalized person emails for one group. */
  fetchTransitiveMembers(groupEmail: string): Promise<string[]>;
}

/** Build the directory client for the configured path. */
export function createDirectoryClient(
  key: ServiceAccountKey,
  config: GroupSyncConfig
): DirectoryClient {
  return config.dwdSubject
    ? new AdminSdkDirectoryClient(key, config)
    : new CloudIdentityDirectoryClient(key, config);
}

// ---------------------------------------------------------------------------
// Cloud Identity path (service account with Groups Reader admin role)
// ---------------------------------------------------------------------------
class CloudIdentityDirectoryClient implements DirectoryClient {
  private readonly api: cloudidentity_v1.Cloudidentity;
  private readonly parent: string;
  /** Lowercased set of known directory-group emails, populated by listGroups(). */
  private groupEmailSet = new Set<string>();

  constructor(key: ServiceAccountKey, config: GroupSyncConfig) {
    if (!config.customerId) {
      throw new Error(
        "GOOGLE_DIRECTORY_CUSTOMER_ID is required for the Cloud Identity path (e.g. Cxxxxxxx). " +
          "Set it in Admin → Settings, or configure GOOGLE_DIRECTORY_DWD_SUBJECT to use the Admin SDK path."
      );
    }
    const authClient = new cloudIdentityAuth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: CLOUD_IDENTITY_SCOPES,
    });
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

// ---------------------------------------------------------------------------
// Admin SDK Directory path (domain-wide delegation, impersonating an admin)
// ---------------------------------------------------------------------------
class AdminSdkDirectoryClient implements DirectoryClient {
  private readonly api: admin_directory_v1.Admin;
  private readonly customer: string;

  constructor(key: ServiceAccountKey, config: GroupSyncConfig) {
    const authClient = new adminAuth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ADMIN_SDK_SCOPES,
      subject: config.dwdSubject ?? undefined,
    });
    this.api = admin({ version: "directory_v1", auth: authClient });
    // For a DWD-impersonated admin, 'my_customer' resolves to the admin's org.
    this.customer = config.customerId ?? "my_customer";
  }

  async listGroups(): Promise<DirectoryGroup[]> {
    const out: DirectoryGroup[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.api.groups.list({
        customer: this.customer,
        maxResults: MEMBER_PAGE_SIZE,
        pageToken,
      });
      for (const g of res.data.groups ?? []) {
        const email = normalizeEmail(g.email);
        if (!email) continue;
        out.push({ email, name: g.name ?? null });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async fetchTransitiveMembers(groupEmail: string): Promise<string[]> {
    // members.list returns DIRECT members; flatten nested groups (type=GROUP)
    // via the shared, cycle-guarded recursion.
    return flattenTransitiveMembers(groupEmail, (g) => this.listDirectMembers(g));
  }

  private async listDirectMembers(groupEmail: string): Promise<RawMember[]> {
    const members: RawMember[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.api.members.list({
        groupKey: normalizeEmail(groupEmail),
        maxResults: MEMBER_PAGE_SIZE,
        pageToken,
      });
      for (const m of res.data.members ?? []) {
        const email = normalizeEmail(m.email);
        if (!email) continue;
        if (m.type === "GROUP") {
          members.push({ email: null, nestedGroupEmail: email });
        } else if (m.type === "USER" || m.type == null) {
          // USER (or an untyped entry we optimistically treat as a person).
          // CUSTOMER (the whole org) is intentionally skipped — not an address.
          members.push({ email });
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return members;
  }
}
