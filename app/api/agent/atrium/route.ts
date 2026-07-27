import { NextRequest, NextResponse } from "next/server";
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context";
import { executeOwnerAtriumOperation } from "@/lib/agent-workspace/atrium-owner-operation";
import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
} from "@/lib/logger";

const log = createLogger({ module: "agent-atrium-broker" });
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const ALLOWED_QUERY_KEYS = new Set([
  "kind",
  "status",
  "collection",
  "tag",
  "query",
]);
const IDENTIFIER = "[A-Za-z0-9%._~-]{1,384}";

type AtriumBody = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
};

function isAllowedMethodPath(method: string, path: string): boolean {
  if (method === "GET") {
    return path === "" || new RegExp(`^/${IDENTIFIER}$`).test(path);
  }
  if (method === "POST") {
    return (
      path === "" ||
      new RegExp(`^/${IDENTIFIER}/(?:versions|publish)$`).test(path)
    );
  }
  if (method === "PATCH") {
    return new RegExp(`^/${IDENTIFIER}(?:/visibility)?$`).test(path);
  }
  if (method === "DELETE") {
    return (
      new RegExp(`^/${IDENTIFIER}$`).test(path) ||
      new RegExp(
        `^/${IDENTIFIER}/publish/(?:intranet|public_web|schoology|google)$`,
      ).test(path)
    );
  }
  return false;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function isAllowedQuery(value: unknown): value is Record<string, string> {
  return (
    value === undefined ||
    (isStringRecord(value) &&
      Object.entries(value).every(
        ([key, item]) => ALLOWED_QUERY_KEYS.has(key) && item.length <= 512,
      ))
  );
}

function isRecordBody(value: unknown): value is Record<string, unknown> {
  return (
    value === undefined ||
    (Boolean(value) && typeof value === "object" && !Array.isArray(value))
  );
}

function parseBody(value: unknown): AtriumBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) =>
        key !== "method" && key !== "path" && key !== "query" && key !== "body",
    ) ||
    typeof raw.method !== "string" ||
    typeof raw.path !== "string" ||
    !isAllowedMethodPath(raw.method, raw.path)
  ) {
    return null;
  }
  if (!isAllowedQuery(raw.query) || !isRecordBody(raw.body)) return null;
  return raw as AtriumBody;
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  });
  if (!context)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = parseBody(raw);
  if (!body) {
    return NextResponse.json(
      { error: "Invalid Atrium operation" },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_REQUEST_BYTES) {
    return NextResponse.json(
      { error: "Request is too large" },
      { status: 413 },
    );
  }

  try {
    const result = await executeOwnerAtriumOperation({
      ownerEmail: context.ownerEmail,
      requestId,
      ...body,
    });
    log.info(
      "Owner-bound Atrium operation completed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        method: body.method,
        path: body.path,
        status: result.httpStatus,
      }),
    );
    return NextResponse.json(result);
  } catch (error) {
    log.warn(
      "Owner-bound Atrium operation failed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { error: "Atrium operation failed" },
      { status: 502 },
    );
  }
}
