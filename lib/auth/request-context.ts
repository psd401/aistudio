import { headers } from "next/headers";
import crypto from "node:crypto";

export async function getRequestId(): Promise<string> {
  const headersList = await headers();
  const requestId = headersList.get("x-request-id") || crypto.randomUUID();
  return requestId;
}

export async function createRequestContext() {
  return {
    requestId: await getRequestId(),
    timestamp: Date.now(),
  };
}