"use client";

import { useState } from "react";
import {
  listArtifactRecords,
  submitArtifactRecord,
  type ArtifactRecordScope,
} from "@/actions/db/atrium/artifact-data";
import type { ArtifactDataPayload } from "@/lib/db/types/jsonb";

type HarnessOperation = "submit" | "list";

interface HarnessResult {
  operation: HarnessOperation;
  state: object;
}

function parsePayload(value: string): ArtifactDataPayload {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Payload must be a JSON object");
  }
  return parsed as ArtifactDataPayload;
}

/**
 * Development-only browser harness for the authenticated Artifact Data Service
 * Server Actions. The page wrapper returns 404 in production; Playwright uses
 * this client to exercise the real Next.js Server Action transport in local E2E.
 */
export function ArtifactDataTestClient(): React.JSX.Element {
  const [contentId, setContentId] = useState("");
  const [namespace, setNamespace] = useState("e2e_leaderboard");
  const [payload, setPayload] = useState('{"score":42}');
  const [scope, setScope] = useState<ArtifactRecordScope>("all");
  const [result, setResult] = useState<HarnessResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function runSubmit(): Promise<void> {
    setBusy(true);
    try {
      const state = await submitArtifactRecord({
        contentId,
        namespace,
        payload: parsePayload(payload),
      });
      setResult({ operation: "submit", state });
    } catch (error) {
      setResult({
        operation: "submit",
        state: {
          isSuccess: false,
          message:
            error instanceof Error ? error.message : "Unexpected request failure",
        },
      });
    } finally {
      setBusy(false);
    }
  }

  async function runList(): Promise<void> {
    setBusy(true);
    try {
      const state = await listArtifactRecords({
        contentId,
        namespace,
        scope,
      });
      setResult({ operation: "list", state });
    } catch (error) {
      setResult({
        operation: "list",
        state: {
          isSuccess: false,
          message:
            error instanceof Error ? error.message : "Unexpected request failure",
        },
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-8">
      <h1 className="text-2xl font-bold">Artifact data E2E harness</h1>
      <p>
        Development-only transport harness for authenticated Artifact Data
        Service actions.
      </p>

      <label className="block">
        Content ID
        <input
          data-testid="artifact-data-content-id"
          className="block w-full border p-2"
          value={contentId}
          onChange={(event) => setContentId(event.target.value)}
        />
      </label>

      <label className="block">
        Namespace
        <input
          data-testid="artifact-data-namespace"
          className="block w-full border p-2"
          value={namespace}
          onChange={(event) => setNamespace(event.target.value)}
        />
      </label>

      <label className="block">
        Payload JSON
        <textarea
          data-testid="artifact-data-payload"
          className="block min-h-24 w-full border p-2 font-mono"
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
        />
      </label>

      <label className="block">
        List scope
        <select
          data-testid="artifact-data-scope"
          className="block border p-2"
          value={scope}
          onChange={(event) =>
            setScope(event.target.value === "mine" ? "mine" : "all")
          }
        >
          <option value="all">all</option>
          <option value="mine">mine</option>
        </select>
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="artifact-data-submit"
          disabled={busy}
          onClick={runSubmit}
        >
          Submit record
        </button>
        <button
          type="button"
          data-testid="artifact-data-list"
          disabled={busy}
          onClick={runList}
        >
          List records
        </button>
      </div>

      <pre
        data-testid="artifact-data-result"
        className="min-h-24 overflow-auto bg-muted p-4"
      >
        {result ? JSON.stringify(result, null, 2) : "No result"}
      </pre>
    </main>
  );
}
