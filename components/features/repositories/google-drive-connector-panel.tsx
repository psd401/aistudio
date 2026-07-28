"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Loader2,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import type { GoogleDriveConnectorView } from "@/lib/repositories/google-drive/connector-service";

interface PickerSession {
  connectorId: string;
  accessToken: string;
  expiresInSeconds: number;
  developerKey: string;
  appId: string;
}

interface PickerCallbackData {
  action?: string;
  docs?: Array<{ id?: string }>;
}

interface PickerBuilderLike {
  addView(view: unknown): PickerBuilderLike;
  enableFeature(feature: unknown): PickerBuilderLike;
  setOAuthToken(token: string): PickerBuilderLike;
  setDeveloperKey(key: string): PickerBuilderLike;
  setAppId(appId: string): PickerBuilderLike;
  setCallback(callback: (data: PickerCallbackData) => void): PickerBuilderLike;
  build(): { setVisible(visible: boolean): void };
}

interface DocsViewLike {
  setIncludeFolders(value: boolean): DocsViewLike;
  setSelectFolderEnabled(value: boolean): DocsViewLike;
}

interface GooglePickerWindow extends Window {
  gapi?: {
    load(name: string, callback: () => void): void;
  };
  google?: {
    picker: {
      Action: { PICKED: string };
      ViewId: { DOCS: string };
      Feature: {
        MULTISELECT_ENABLED: unknown;
        SUPPORT_DRIVES: unknown;
      };
      DocsView: new (viewId: string) => DocsViewLike;
      PickerBuilder: new () => PickerBuilderLike;
    };
  };
}

const googlePickerWindow = (): GooglePickerWindow =>
  window as GooglePickerWindow;
type Toast = ReturnType<typeof useToast>["toast"];

let pickerLoader: Promise<void> | null = null;

function loadGooglePicker(): Promise<void> {
  if (pickerLoader) return pickerLoader;
  pickerLoader = new Promise<void>((resolve, reject) => {
    const pickerWindow = googlePickerWindow();
    const loadPickerApi = () => {
      const gapi = pickerWindow.gapi;
      if (!gapi) {
        reject(new Error("Google Picker API failed to load"));
        return;
      }
      gapi.load("picker", resolve);
    };
    if (pickerWindow.gapi) {
      loadPickerApi();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-google-picker="true"]',
    );
    if (existing) {
      existing.addEventListener("load", loadPickerApi, { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Google Picker API failed to load")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.dataset.googlePicker = "true";
    script.addEventListener("load", loadPickerApi, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Google Picker API failed to load")),
      { once: true },
    );
    document.head.appendChild(script);
  });
  return pickerLoader;
}

function postJson(
  url: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function statusVariant(
  status: GoogleDriveConnectorView["status"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active") return "default";
  if (status === "degraded" || status === "revoked") return "destructive";
  if (status === "pending") return "secondary";
  return "outline";
}

function findPersonalConnector(connectors: GoogleDriveConnectorView[]) {
  return connectors.find(
    ({ authMode, status, ownedByViewer }) =>
      authMode === "personal_oauth" && status !== "revoked" && ownedByViewer,
  );
}

function GoogleDriveLoading() {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading Google Drive connections…
    </div>
  );
}

interface GoogleDriveConnectorPanelProps {
  repositoryId: number;
  onSourcesChanged?: () => void;
}

interface PickerSelectionContext {
  loadConnectors: () => Promise<void>;
  onSourcesChanged?: () => void;
  repositoryId: number;
  setPendingAction: (value: string | null) => void;
  toast: Toast;
}

async function savePickerSelection(
  session: PickerSession,
  fileIds: string[],
  context: PickerSelectionContext,
) {
  context.setPendingAction("selection");
  try {
    const response = await fetch(
      `/api/repositories/${context.repositoryId}/connectors/google/selections`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectorId: session.connectorId, fileIds }),
      },
    );
    const result = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(result.error || "Failed to save Drive selection");
    }
    context.toast({
      title: "Drive sources selected",
      description:
        "Synchronization has been queued. New versions will reindex automatically.",
    });
    context.onSourcesChanged?.();
    await context.loadConnectors();
  } catch (error) {
    context.toast({
      title: "Drive selection failed",
      description:
        error instanceof Error
          ? error.message
          : "Failed to save Drive selection",
      variant: "destructive",
    });
  } finally {
    context.setPendingAction(null);
  }
}

function showGooglePicker(
  session: PickerSession,
  context: PickerSelectionContext,
) {
  const pickerApi = googlePickerWindow().google?.picker;
  if (!pickerApi) throw new Error("Google Picker API is unavailable");

  const view = new pickerApi.DocsView(pickerApi.ViewId.DOCS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(true);
  const picker = new pickerApi.PickerBuilder()
    .addView(view)
    .enableFeature(pickerApi.Feature.MULTISELECT_ENABLED)
    .enableFeature(pickerApi.Feature.SUPPORT_DRIVES)
    .setOAuthToken(session.accessToken)
    .setDeveloperKey(session.developerKey)
    .setAppId(session.appId)
    .setCallback(data => {
      if (data.action !== pickerApi.Action.PICKED) return;
      const fileIds = (data.docs ?? []).flatMap(document =>
        document.id ? [document.id] : [],
      );
      if (fileIds.length > 0) {
        void savePickerSelection(session, fileIds, context);
      }
    })
    .build();
  picker.setVisible(true);
}

function ConnectorHealth({
  connectors,
  pendingAction,
  onDisconnect,
  onSync,
}: {
  connectors: GoogleDriveConnectorView[];
  pendingAction: string | null;
  onDisconnect: (connectorId: string) => void;
  onSync: (connectorId: string) => void;
}) {
  if (connectors.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Connection health</h3>
      {connectors.map(connector => (
        <div
          key={connector.id}
          className="rounded-md border p-3 text-sm"
          data-testid={`google-connector-${connector.id}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {connector.status === "active" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <AlertCircle className="h-4 w-4 text-amber-600" />
              )}
              <span className="font-medium">{connector.displayName}</span>
              <Badge variant={statusVariant(connector.status)}>
                {connector.status}
              </Badge>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pendingAction !== null}
                onClick={() => onSync(connector.id)}
              >
                {pendingAction === `sync:${connector.id}` ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3 w-3" />
                )}
                Sync now
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pendingAction !== null}
                onClick={() => onDisconnect(connector.id)}
              >
                <Unplug className="mr-1 h-3 w-3" />
                Disconnect
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {connector.lastSuccessAt
              ? `Last successful sync ${new Date(
                  connector.lastSuccessAt,
                ).toLocaleString()}`
              : "Initial synchronization pending"}
            {" · "}
            {connector.selections.filter(({ active }) => active).length}{" "}
            selection(s)
            {" · "}
            {Object.values(connector.sourceCounts).reduce(
              (sum, count) => sum + count,
              0,
            )}{" "}
            tracked source(s)
          </p>
          {connector.lastErrorMessage && (
            <p className="mt-1 text-xs text-destructive">
              {connector.lastErrorMessage}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function ConnectorPanelContent({
  connectors,
  error,
  pendingAction,
  personalConnector,
  repositoryId,
  onChooseSources,
  onDisconnect,
  onSync,
}: {
  connectors: GoogleDriveConnectorView[];
  error: string | null;
  pendingAction: string | null;
  personalConnector: GoogleDriveConnectorView | undefined;
  repositoryId: number;
  onChooseSources: () => void;
  onDisconnect: (connectorId: string) => void;
  onSync: (connectorId: string) => void;
}) {
  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Google Drive configuration unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="rounded-md border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-medium">Google Drive</h3>
            <p className="text-sm text-muted-foreground">
              Connect with read-only access, then choose files or folders from
              My Drive or Shared Drives that you can already access.
            </p>
          </div>
          {personalConnector ? (
            <Button
              type="button"
              onClick={onChooseSources}
              disabled={pendingAction !== null}
            >
              {pendingAction === "picker" && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Choose sources
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() =>
                window.location.assign(
                  `/api/repositories/${repositoryId}/connectors/google/authorize`,
                )
              }
            >
              <Cloud className="mr-2 h-4 w-4" />
              Connect Google Drive
            </Button>
          )}
        </div>
      </div>
      <ConnectorHealth
        connectors={connectors}
        pendingAction={pendingAction}
        onDisconnect={onDisconnect}
        onSync={onSync}
      />
    </div>
  );
}

export function GoogleDriveConnectorPanel({
  repositoryId,
  onSourcesChanged,
}: GoogleDriveConnectorPanelProps) {
  const { toast } = useToast();
  const [connectors, setConnectors] = useState<GoogleDriveConnectorView[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConnectors = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/repositories/${repositoryId}/connectors/google`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as {
        connectors?: GoogleDriveConnectorView[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load Drive connections");
      }
      setConnectors(payload.connectors ?? []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load Drive connections",
      );
    } finally {
      setIsLoading(false);
    }
  }, [repositoryId]);

  useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  async function choosePersonalDriveSources() {
    setPendingAction("picker");
    try {
      const sessionResponse = await fetch(
        `/api/repositories/${repositoryId}/connectors/google/picker`,
        { cache: "no-store" },
      );
      const sessionPayload = (await sessionResponse.json()) as
        PickerSession | { error: string };
      if (!sessionResponse.ok || !("connectorId" in sessionPayload)) {
        throw new Error(
          "error" in sessionPayload
            ? sessionPayload.error
            : "Failed to start Google Picker",
        );
      }
      await loadGooglePicker();
      showGooglePicker(sessionPayload, {
        loadConnectors,
        onSourcesChanged,
        repositoryId,
        setPendingAction,
        toast,
      });
    } catch (pickerError) {
      toast({
        title: "Google Drive unavailable",
        description:
          pickerError instanceof Error
            ? pickerError.message
            : "Failed to open Google Picker",
        variant: "destructive",
      });
    } finally {
      if (pendingAction !== "selection") setPendingAction(null);
    }
  }

  async function syncConnector(connectorId: string) {
    setPendingAction(`sync:${connectorId}`);
    try {
      const response = await postJson(
        `/api/repositories/${repositoryId}/connectors/google/${connectorId}/sync`,
      );
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Failed to queue synchronization");
      }
      toast({
        title: "Synchronization queued",
        description: "The connector will reconcile from its durable cursor.",
      });
      await loadConnectors();
    } catch (syncError) {
      toast({
        title: "Synchronization failed",
        description:
          syncError instanceof Error
            ? syncError.message
            : "Failed to queue synchronization",
        variant: "destructive",
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function disconnectConnector(connectorId: string) {
    setPendingAction(`disconnect:${connectorId}`);
    try {
      const response = await fetch(
        `/api/repositories/${repositoryId}/connectors/google/${connectorId}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Failed to disconnect Drive");
      }
      toast({
        title: "Google Drive disconnected",
        description: "Synchronized sources are no longer retrievable.",
      });
      onSourcesChanged?.();
      await loadConnectors();
    } catch (disconnectError) {
      toast({
        title: "Disconnect failed",
        description:
          disconnectError instanceof Error
            ? disconnectError.message
            : "Failed to disconnect Drive",
        variant: "destructive",
      });
    } finally {
      setPendingAction(null);
    }
  }

  const personalConnector = findPersonalConnector(connectors);
  if (isLoading) return <GoogleDriveLoading />;

  return (
    <ConnectorPanelContent
      connectors={connectors}
      error={error}
      pendingAction={pendingAction}
      personalConnector={personalConnector}
      repositoryId={repositoryId}
      onChooseSources={() => void choosePersonalDriveSources()}
      onDisconnect={connectorId => void disconnectConnector(connectorId)}
      onSync={connectorId => void syncConnector(connectorId)}
    />
  );
}
