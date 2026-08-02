"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { meridianPortalClassName } from "@/lib/meridian/fonts";
import type { RepositoryMigrationException } from "@/lib/repositories/content-platform/migration-control-service";

export interface MigrationExceptionReasonRequest {
  kind: "approve" | "exclude";
  item: RepositoryMigrationException;
}

export function MigrationExceptionReasonDialog({
  request,
  reason,
  busy,
  onClose,
  onReasonChange,
  onSubmit,
}: {
  request: MigrationExceptionReasonRequest | null;
  reason: string;
  busy: boolean;
  onClose: () => void;
  onReasonChange: (reason: string) => void;
  onSubmit: () => void;
}) {
  const trimmedReasonLength = reason.trim().length;
  const isExclude = request?.kind === "exclude";
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className={`sm:max-w-lg ${meridianPortalClassName}`}>
        <DialogHeader>
          <DialogTitle>
            {isExclude
              ? "Exclude legacy source?"
              : "Approve extraction mismatch?"}
          </DialogTitle>
          <DialogDescription>
            {isExclude
              ? "Record why this failed or unrecoverable legacy source is intentionally excluded from cutover. The reason and administrator identity are retained in the migration audit trail."
              : "Record why this extraction difference is acceptable. The reason and administrator identity are retained in the migration audit trail."}
          </DialogDescription>
        </DialogHeader>
        {request ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              {request.item.sourceKind.replaceAll("_", " ")} #
              {request.item.sourceId}
            </p>
            <div className="space-y-2">
              <Label htmlFor="migration-exception-reason">Audit reason</Label>
              <Textarea
                id="migration-exception-reason"
                maxLength={1000}
                minLength={10}
                onChange={(event) => onReasonChange(event.target.value)}
                placeholder="Describe the evidence and why this decision is safe."
                rows={5}
                value={reason}
              />
              <p className="text-xs text-muted-foreground">
                {trimmedReasonLength}/1000 characters; at least 10 required.
              </p>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={busy || trimmedReasonLength < 10}
            onClick={onSubmit}
            type="button"
            variant={isExclude ? "destructive" : "default"}
          >
            {isExclude ? "Exclude source" : "Approve mismatch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
