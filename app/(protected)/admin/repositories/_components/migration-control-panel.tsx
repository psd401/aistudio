"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";
import {
  approveRepositoryMigrationMismatchAction,
  getRepositoryMigrationDashboardAction,
  reprocessRepositoryMigrationItemAction,
  retryRepositoryMigrationItemAction,
  runRepositoryMigrationRollbackDrillAction,
  startRepositoryMigrationRollbackAction,
  startRepositoryMigrationAction,
} from "@/actions/admin/repository-migration.actions";
import type {
  RepositoryMigrationDashboard,
  RepositoryMigrationException,
} from "@/lib/repositories/content-platform/migration-control-service";

interface MigrationPanelState {
  dashboard: RepositoryMigrationDashboard;
  exceptions: RepositoryMigrationException[];
}

function abbreviatedHash(value: string | null): string {
  return value ? `${value.slice(0, 12)}…` : "—";
}

export function MigrationControlPanel() {
  const { toast } = useToast();
  const [state, setState] = useState<MigrationPanelState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      const result = await getRepositoryMigrationDashboardAction();
      if (result.isSuccess && result.data) {
        setState(result.data);
      } else if (!quiet) {
        toast({
          title: "Migration status unavailable",
          description: result.message,
          variant: "destructive",
        });
      }
      if (!quiet) setLoading(false);
    },
    [toast],
  );

  useEffect(() => {
    let cancelled = false;
    const initialTimer = window.setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    const timer = window.setInterval(() => {
      if (!cancelled) void load(true);
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [load]);

  const runAction = useCallback(
    async (
      key: string,
      action: () => Promise<{ isSuccess: boolean; message: string }>,
    ) => {
      setPendingAction(key);
      const result = await action();
      toast({
        title: result.isSuccess ? "Content migration updated" : "Action failed",
        description: result.message,
        variant: result.isSuccess ? "default" : "destructive",
      });
      setPendingAction(null);
      await load(true);
    },
    [load, toast],
  );

  const approveMismatch = useCallback(
    async (item: RepositoryMigrationException) => {
      const reason = window.prompt(
        "Document why this extraction difference is acceptable (10-1000 characters):",
      );
      if (!reason) return;
      await runAction(`approve:${item.id}`, () =>
        approveRepositoryMigrationMismatchAction({
          migrationItemId: item.id,
          reason,
        }),
      );
    },
    [runAction],
  );

  if (loading && !state) {
    return (
      <Card data-testid="content-migration-panel">
        <CardContent className="flex min-h-40 items-center justify-center">
          <Loader2
            className="h-6 w-6 animate-spin"
            aria-label="Loading migration status"
          />
        </CardContent>
      </Card>
    );
  }
  if (!state) return null;

  const { dashboard, exceptions } = state;
  const metrics = dashboard.migrationMetrics;
  const controlsDisabled =
    pendingAction !== null ||
    dashboard.activeRunCount > 0 ||
    dashboard.retirementFinalized;
  const rollbackParent = dashboard.runs.find(
    (run) =>
      run.mode === "backfill" &&
      ["completed", "completed_with_errors"].includes(run.status) &&
      run.recoveryWindowEndsAt &&
      new Date(run.recoveryWindowEndsAt) > new Date(),
  );
  return (
    <Card className="mb-6" data-testid="content-migration-panel">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Unified content migration</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Dry-run, backfill, reconcile, and verify legacy content before
            retirement.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          {dashboard.inventory.map((entry) => (
            <div key={entry.sourceKind} className="rounded-lg border p-3">
              <div className="text-xs font-medium uppercase text-muted-foreground">
                {entry.sourceKind.replaceAll("_", " ")}
              </div>
              <div className="mt-1 text-2xl font-semibold">
                {entry.discovered}
              </div>
              <div className="text-xs text-muted-foreground">
                {entry.verified} verified / {entry.tracked} tracked
                {entry.uncovered > 0 ? ` / ${entry.uncovered} uncovered` : ""}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">{metrics.migrated ?? 0} migrated</Badge>
          <Badge variant="secondary">{metrics.verified ?? 0} verified</Badge>
          <Badge
            variant={
              (metrics.mismatched ?? 0) > 0 ? "destructive" : "secondary"
            }
          >
            {metrics.mismatched ?? 0} mismatched
          </Badge>
          <Badge
            variant={(metrics.failed ?? 0) > 0 ? "destructive" : "secondary"}
          >
            {metrics.failed ?? 0} failed
          </Badge>
          <Badge
            variant={
              dashboard.staleRepositoryCount > 0 ? "destructive" : "secondary"
            }
          >
            {dashboard.staleRepositoryCount} stale indexes
          </Badge>
          <Badge variant="outline">
            {dashboard.retrievalShadow.observations} retrieval probes / 24h
          </Badge>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void runAction("dry-run", () =>
                startRepositoryMigrationAction({ mode: "dry_run" }),
              )
            }
            disabled={controlsDisabled}
          >
            {pendingAction === "dry-run" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Dry run
          </Button>
          <Button
            onClick={() =>
              void runAction("backfill", () =>
                startRepositoryMigrationAction({ mode: "backfill" }),
              )
            }
            disabled={controlsDisabled}
          >
            {pendingAction === "backfill" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Start backfill
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void runAction("reconcile", () =>
                startRepositoryMigrationAction({ mode: "reconcile" }),
              )
            }
            disabled={controlsDisabled}
          >
            <ShieldCheck className="mr-2 h-4 w-4" />
            Reconcile
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void runAction("rollback-drill", () =>
                runRepositoryMigrationRollbackDrillAction(),
              )
            }
            disabled={controlsDisabled}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Rollback drill
          </Button>
          {rollbackParent && (
            <Button
              variant="destructive"
              onClick={() => {
                if (
                  window.confirm(
                    "Roll back every canonical source created by this backfill run? Legacy rows are preserved, but canonical processing must be restarted to cut over again.",
                  )
                ) {
                  void runAction("rollback", () =>
                    startRepositoryMigrationRollbackAction(rollbackParent.id),
                  );
                }
              }}
              disabled={controlsDisabled}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Roll back backfill
            </Button>
          )}
        </div>

        <div
          className={`rounded-lg border p-3 ${
            dashboard.retirement.ready
              ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20"
              : "border-amber-300 bg-amber-50 dark:bg-amber-950/20"
          }`}
          data-testid="content-retirement-readiness"
        >
          <div className="flex items-center gap-2 font-medium">
            {dashboard.retirement.ready ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            )}
            {dashboard.retirementFinalized
              ? "Legacy content retirement finalized"
              : dashboard.retirement.ready
                ? "Legacy retirement gate passed"
                : "Legacy retirement is blocked"}
          </div>
          {!dashboard.retirement.ready && (
            <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
              {dashboard.retirement.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          )}
        </div>

        {exceptions.length > 0 && (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Count / hash evidence</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Recovery</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exceptions.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      {item.sourceKind.replaceAll("_", " ")} #{item.sourceId}
                    </TableCell>
                    <TableCell>
                      <Badge variant="destructive">{item.status}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {item.sourceRecordCount ?? "—"} /{" "}
                      {item.canonicalRecordCount ?? "—"}
                      <br />
                      {abbreviatedHash(item.sourceContentSha256)} /{" "}
                      {abbreviatedHash(item.canonicalContentSha256)}
                    </TableCell>
                    <TableCell className="max-w-xs text-sm">
                      {item.lastErrorMessage ?? item.lastErrorCode ?? "Unknown"}
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      {item.status === "mismatch" ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void runAction(`reprocess:${item.id}`, () =>
                                reprocessRepositoryMigrationItemAction(item.id),
                              )
                            }
                            disabled={controlsDisabled}
                          >
                            Reprocess
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void approveMismatch(item)}
                            disabled={controlsDisabled}
                          >
                            Approve
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void runAction(`retry:${item.id}`, () =>
                              retryRepositoryMigrationItemAction(item.id),
                            )
                          }
                          disabled={controlsDisabled}
                        >
                          Retry
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
