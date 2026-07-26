/**
 * ClassLink OneRoster HTTP client.
 *
 * Implements only ClassLink's documented server-to-server modes:
 *   - OAuth1 HMAC-SHA1 direct to a district Roster Server.
 *   - Static bearer access through the ClassLink OAuth2 Proxy.
 * There is intentionally no token endpoint or generic OAuth2 client-credentials
 * flow. All query parameters are included in the OAuth1 signature base string.
 */

import { createHmac, randomBytes } from "node:crypto";
import type {
  OneRosterApiVersion,
  OneRosterCredentials,
} from "./config";
import { isRecord, type JsonRecord } from "./normalize";

export const COLLECTIONS = [
  "orgs",
  "academicSessions",
  "courses",
  "classes",
  "users",
  "enrollments",
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

const COLLECTION_FIELDS: Record<CollectionName, string> = {
  orgs:
    "sourcedId,status,dateLastModified,name,type,identifier,parent",
  academicSessions:
    "sourcedId,status,dateLastModified,title,type,startDate,endDate,parent,schoolYear",
  courses:
    "sourcedId,status,dateLastModified,title,courseCode,orgs,org,grades",
  classes:
    "sourcedId,status,dateLastModified,title,classCode,classType,location,course,school,terms,grades,subjects,periods",
  users:
    "sourcedId,status,dateLastModified,email,username,givenName,familyName,role,roles,orgs,enabledUser,grades",
  enrollments:
    "sourcedId,status,dateLastModified,user,class,school,role,primary,beginDate,endDate",
};

export interface ResponseHeaders {
  get(name: string): string | null;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: ResponseHeaders;
  json(): Promise<unknown>;
}

export type HttpTransport = (
  url: string,
  init: { method: "GET"; headers: Record<string, string> }
) => Promise<HttpResponse>;

export interface OneRosterClientOptions {
  baseUrl: string;
  apiVersion: OneRosterApiVersion;
  pageSize: number;
  credentials: OneRosterCredentials;
  transport?: HttpTransport;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  nowSeconds?: () => number;
  nonce?: () => string;
  maxRequestRetries?: number;
}

export interface CollectionPullSuccess {
  name: CollectionName;
  records: JsonRecord[];
  permRev: string | null;
  complete: true;
}

export interface CollectionPullFailure {
  name: CollectionName;
  error: string;
}

export type CollectionPullResult =
  | CollectionPullSuccess
  | CollectionPullFailure;

export interface RosterPull {
  unchanged: boolean;
  permRev: string | null;
  collections: CollectionPullResult[];
}

export class RevisionChangedError extends Error {
  constructor() {
    super("x-perm-rev changed during the OneRoster pull");
    this.name = "RevisionChangedError";
  }
}

export class OneRosterClient {
  private readonly baseUrl: string;
  private readonly apiVersion: OneRosterApiVersion;
  private readonly pageSize: number;
  private readonly credentials: OneRosterCredentials;
  private readonly transport: HttpTransport;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly nowSeconds: () => number;
  private readonly nonce: () => string;
  private readonly maxRequestRetries: number;

  constructor(options: OneRosterClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiVersion = options.apiVersion;
    this.pageSize = options.pageSize;
    this.credentials = options.credentials;
    this.transport = options.transport ?? defaultTransport;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
    this.nonce =
      options.nonce ?? (() => randomBytes(16).toString("hex"));
    this.maxRequestRetries = options.maxRequestRetries ?? 5;
  }

  /**
   * Pull every v1 collection in dependency order. Collection failures are
   * isolated so their last-known-good rows survive while later collections can
   * still refresh. A revision change is different: all staged data is stale, so
   * it escapes for the bounded whole-pull restart in sync.ts.
   */
  async pullAll(previousPermRev: string | null): Promise<RosterPull> {
    const results: CollectionPullResult[] = [];
    let batchPermRev: string | null = null;

    for (const name of COLLECTIONS) {
      try {
        const collection = await this.fetchCollection(name, batchPermRev);
        batchPermRev ??= collection.permRev;
        if (
          results.length === 0 &&
          previousPermRev &&
          collection.permRev === previousPermRev
        ) {
          return {
            unchanged: true,
            permRev: collection.permRev,
            collections: [],
          };
        }
        results.push(collection);
      } catch (error) {
        if (error instanceof RevisionChangedError) throw error;
        results.push({ name, error: safeErrorMessage(error) });
      }
    }

    if (!results.some((result) => "records" in result)) {
      throw new Error("Every OneRoster collection failed");
    }
    return {
      unchanged: false,
      permRev: batchPermRev,
      collections: results,
    };
  }

  async fetchCollection(
    name: CollectionName,
    expectedPermRev: string | null
  ): Promise<CollectionPullSuccess> {
    const records: JsonRecord[] = [];
    let offset = 0;
    let totalCount: number | null = null;
    let permRev = expectedPermRev;

    while (true) {
      const url = this.collectionUrl(name, offset);
      const response = await this.request(url);
      const pagePermRev = cleanHeader(response.headers.get("x-perm-rev"));
      if (!pagePermRev) {
        throw new Error(`${name} response is missing x-perm-rev`);
      }
      if (permRev && pagePermRev !== permRev) {
        throw new RevisionChangedError();
      }
      permRev ??= pagePermRev;

      const page = extractRecords(await response.json(), name);
      const xCount = parseCountHeader(response.headers.get("x-count"), "x-count");
      if (xCount !== null && xCount !== page.length) {
        throw new Error(`${name} returned an inconsistent x-count header`);
      }
      const pageTotal = parseCountHeader(
        response.headers.get("x-total-count"),
        "x-total-count"
      );
      if (
        totalCount !== null &&
        pageTotal !== null &&
        pageTotal !== totalCount
      ) {
        throw new Error(`${name} changed x-total-count during paging`);
      }
      totalCount ??= pageTotal;

      if (page.length === 0) {
        if (totalCount !== null && records.length < totalCount) {
          throw new Error(`${name} paging ended before x-total-count was reached`);
        }
        break;
      }

      records.push(...page);
      if (totalCount !== null && records.length > totalCount) {
        throw new Error(`${name} returned more records than x-total-count`);
      }
      if (totalCount !== null && records.length >= totalCount) break;
      if (totalCount === null && page.length < this.pageSize) break;
      offset += this.pageSize;
    }

    return { name, records, permRev, complete: true };
  }

  private collectionUrl(name: CollectionName, offset: number): string {
    const path =
      this.apiVersion === "v1p2"
        ? `/ims/oneroster/rostering/v1p2/${name}`
        : `/ims/oneroster/v1p1/${name}`;
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("limit", String(this.pageSize));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("fields", COLLECTION_FIELDS[name]);
    return url.toString();
  }

  private async request(url: string): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt += 1) {
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (this.credentials.mode === "proxy") {
        headers.Authorization = `Bearer ${this.credentials.bearerToken}`;
      } else {
        headers.Authorization = buildOAuth1Header({
          method: "GET",
          url,
          consumerKey: this.credentials.consumerKey,
          consumerSecret: this.credentials.consumerSecret,
          timestamp: this.nowSeconds(),
          nonce: this.nonce(),
        });
      }

      const response = await this.transport(url, { method: "GET", headers });
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status === 502;
      if (!retryable || attempt >= this.maxRequestRetries) {
        throw new Error(`OneRoster request failed with HTTP ${response.status}`);
      }
      const exponential = Math.min(32_000, 1_000 * 2 ** attempt);
      const jitter = Math.floor(this.random() * 1_000);
      const retryAfter = retryAfterMilliseconds(
        response.headers.get("retry-after")
      );
      await this.sleep(Math.max(exponential + jitter, retryAfter ?? 0));
    }
  }
}

interface OAuth1HeaderInput {
  method: "GET";
  url: string;
  consumerKey: string;
  consumerSecret: string;
  timestamp: number;
  nonce: string;
}

export function buildOAuth1Header(input: OAuth1HeaderInput): string {
  const url = new URL(input.url);
  const oauth = new Map<string, string>([
    ["oauth_consumer_key", input.consumerKey],
    ["oauth_nonce", input.nonce],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", String(input.timestamp)],
    ["oauth_version", "1.0"],
  ]);
  const parameters: [string, string][] = [];
  for (const [key, value] of url.searchParams.entries()) {
    parameters.push([key, value]);
  }
  for (const entry of oauth.entries()) parameters.push(entry);
  parameters.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyOrder = oauthEncode(leftKey).localeCompare(oauthEncode(rightKey));
    return keyOrder || oauthEncode(leftValue).localeCompare(oauthEncode(rightValue));
  });
  const normalized = parameters
    .map(([key, value]) => `${oauthEncode(key)}=${oauthEncode(value)}`)
    .join("&");
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const signatureBase = [
    input.method,
    oauthEncode(baseUrl),
    oauthEncode(normalized),
  ].join("&");
  const signingKey = `${oauthEncode(input.consumerSecret)}&`;
  const signature = createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");
  oauth.set("oauth_signature", signature);
  return (
    "OAuth " +
    [...oauth.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`)
      .join(", ")
  );
}

function oauthEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function extractRecords(value: unknown, name: CollectionName): JsonRecord[] {
  const raw =
    Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value[name])
        ? value[name]
        : null;
  if (!raw) {
    throw new Error(`${name} response is missing its collection array`);
  }
  if (!raw.every(isRecord)) {
    throw new Error(`${name} response contains a non-object record`);
  }
  return raw;
}

function parseCountHeader(value: string | null, name: string): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`OneRoster returned an invalid ${name} header`);
  }
  return parsed;
}

function cleanHeader(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

async function defaultTransport(
  url: string,
  init: { method: "GET"; headers: Record<string, string> }
): Promise<HttpResponse> {
  return fetch(url, init);
}
