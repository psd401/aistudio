/**
 * Outbound HTTP boundary for attacker-controlled URLs.
 *
 * The hostname is resolved once, every returned address is checked, and the
 * socket lookup is pinned to that approved result. This closes the validation /
 * connection DNS-rebinding gap that exists when URL validation is followed by a
 * normal `fetch()`.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import {
  BlockList,
  isIP,
} from "node:net";
import { Readable } from "node:stream";

export interface SafeFetchInit {
  method?: string;
  headers?: HeadersInit;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (
  hostname: string
) => Promise<readonly ResolvedAddress[]>;

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

const defaultResolver: HostResolver = async (hostname) => {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

/** Return true only for globally routable IPv4/IPv6 addresses. */
export function isPublicAddress(address: string): boolean {
  // Block IPv4-mapped IPv6 explicitly. Adding ::ffff:0:0/96 to Node's
  // BlockList also causes ordinary IPv4 inputs to be treated as mapped and
  // rejected, so keep this check separate.
  if (address.toLowerCase().startsWith("::ffff:")) return false;
  const family = isIP(address);
  if (family === 4) return !blockedAddresses.check(address, "ipv4");
  if (family === 6) return !blockedAddresses.check(address, "ipv6");
  return false;
}

/**
 * Resolve a hostname and reject the entire answer if any address is non-public.
 *
 * Rejecting mixed public/private answers matters: otherwise DNS response
 * ordering or a connection retry could select a private address.
 */
export async function resolvePublicAddresses(
  hostname: string,
  resolver: HostResolver = defaultResolver
): Promise<readonly ResolvedAddress[]> {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "metadata.google.internal"
  ) {
    throw new Error("Outbound target resolves to a private/internal address");
  }

  const addresses = await resolver(normalized);
  if (addresses.length === 0) {
    throw new Error("Outbound target did not resolve");
  }
  if (
    addresses.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) || !isPublicAddress(address)
    )
  ) {
    throw new Error("Outbound target resolves to a private/internal address");
  }
  return addresses;
}

/**
 * Build an origin-form request that connects to the already-approved address.
 *
 * The untrusted hostname is retained only for the HTTP Host header and TLS
 * certificate/SNI checks. The socket destination itself is the validated IP,
 * so neither a second DNS lookup nor DNS rebinding can redirect the connection.
 */
export function createPinnedRequestOptions(
  url: URL,
  approved: readonly ResolvedAddress[],
  init: SafeFetchInit = {}
): HttpsRequestOptions {
  const destination = approved[0];
  if (!destination) {
    throw new Error("Outbound target did not resolve");
  }

  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  const hasCredentials = url.username.length > 0 || url.password.length > 0;

  return {
    protocol: url.protocol,
    hostname: destination.address,
    family: destination.family,
    port: url.port ? Number.parseInt(url.port, 10) : undefined,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    signal: init.signal,
    // Preserve the original hostname for TLS SNI/certificate verification.
    servername: url.hostname.replace(/^\[|\]$/g, ""),
    auth: hasCredentials
      ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
      : undefined,
  };
}

type SafeFetchTestTransport = (
  input: URL,
  init: RequestInit
) => Promise<Response>;

let testTransport: SafeFetchTestTransport | undefined;

/**
 * Inject a transport only in tests. Production callers always use the pinned
 * Node socket path below.
 */
export function setSafeFetchTransportForTests(
  transport: SafeFetchTestTransport | undefined
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Safe-fetch test transport can only be changed in tests");
  }
  testTransport = transport;
}

/**
 * Fetch one URL without following redirects. Callers must validate/reissue each
 * redirect so every hop receives a fresh resolve/check/pin cycle.
 */
export async function safeFetch(
  input: string | URL,
  init: SafeFetchInit = {}
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Outbound URL must use HTTP or HTTPS");
  }
  if (testTransport) {
    return testTransport(url, {
      method: init.method,
      headers: init.headers,
      body: init.body as BodyInit | undefined,
      signal: init.signal,
      redirect: "manual",
    });
  }

  const approved = await resolvePublicAddresses(url.hostname);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const requestOptions = createPinnedRequestOptions(url, approved, init);

  return new Promise<Response>((resolve, reject) => {
    const req = request(
      requestOptions,
      (res) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        resolve(
          new Response(
            Readable.toWeb(res) as ReadableStream<Uint8Array>,
            {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage,
              headers: responseHeaders,
            }
          )
        );
      }
    );
    req.once("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function bodyFromDirectInit(
  candidate: RequestInit["body"],
): string | Uint8Array | undefined {
  if (typeof candidate === "string") return candidate;
  if (candidate instanceof URLSearchParams) return candidate.toString();
  if (candidate instanceof Uint8Array) return candidate;
  if (candidate instanceof ArrayBuffer) return new Uint8Array(candidate);
  if (candidate === undefined || candidate === null) return undefined;
  throw new Error("Safe MCP transport accepts only bounded byte request bodies");
}

async function getSafeRequestBody(options: {
  method: string;
  directUrl: URL | undefined;
  request: Request | undefined;
  body: RequestInit["body"];
}): Promise<string | Uint8Array | undefined> {
  const { method, directUrl, request, body } = options;
  if (method === "GET" || method === "HEAD") return undefined;
  if (directUrl) return bodyFromDirectInit(body);
  if (!request) return undefined;
  return new Uint8Array(await request.arrayBuffer());
}

function directInputUrl(input: RequestInfo | URL): URL | undefined {
  if (typeof input === "string" || input instanceof URL) {
    return new URL(input.toString());
  }
  return undefined;
}

/**
 * Fetch-compatible adapter for libraries such as @ai-sdk/mcp.
 *
 * Reconstructing a Request gives us one bounded byte body and prevents the
 * caller from smuggling a redirect policy or alternate socket implementation
 * around safeFetch. Every SDK request therefore resolves and pins its own
 * approved public address and rejects redirects.
 */
export async function safeFetchAdapter(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const directUrl = directInputUrl(input)
  const request = directUrl ? undefined : new Request(input, init)
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase()
  const body = await getSafeRequestBody({
    method,
    directUrl,
    request,
    body: init?.body,
  })
  return safeFetch(directUrl ?? request!.url, {
    method,
    headers: init?.headers ?? request?.headers,
    body,
    signal: init?.signal ?? request?.signal,
  })
}
