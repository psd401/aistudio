"use client";

import { useState, useCallback, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertTriangle, Info } from "lucide-react";
import type { SelectAiModel } from "@/types";

interface ModelReplacementDialogProps {
  isOpen: boolean;
  onClose: () => void;
  modelToDelete: SelectAiModel;
  availableModels: SelectAiModel[];
  referenceCounts: {
    chainPrompts: number;
    conversations: number;
    modelComparisons: number;
    promptLibrary: number;
  };
  onConfirm: (replacementModelId: number) => Promise<void>;
}

function modelCompatibilityWarnings(
  original: SelectAiModel,
  replacement: SelectAiModel | undefined,
): string[] {
  if (!replacement) return [];
  const warnings: string[] = [];
  if (original.nexusEnabled && !replacement.nexusEnabled) {
    warnings.push(
      "The selected replacement model is not Nexus-enabled, but the original model is.",
    );
  }
  if (original.architectEnabled && !replacement.architectEnabled) {
    warnings.push(
      "The selected replacement model is not Architect-enabled, but the original model is.",
    );
  }
  if (original.provider !== replacement.provider) {
    warnings.push(
      `Provider mismatch: Original uses ${original.provider}, replacement uses ${replacement.provider}.`,
    );
  }
  return warnings;
}

function AffectedModelRecords({
  counts,
}: {
  counts: ModelReplacementDialogProps["referenceCounts"];
}) {
  const records = [
    {
      count: counts.chainPrompts,
      singular: "Assistant Architect",
      plural: "Assistant Architects",
    },
    {
      count: counts.conversations,
      singular: "Chat Conversation",
      plural: "Chat Conversations",
    },
    {
      count: counts.modelComparisons,
      singular: "Model Comparison",
      plural: "Model Comparisons",
    },
    {
      count: counts.promptLibrary,
      singular: "Prompt Library entry",
      plural: "Prompt Library entries",
    },
  ];
  const total = records.reduce((sum, record) => sum + record.count, 0);
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <h4 className="font-medium text-sm">Affected Records</h4>
      <div className="text-sm text-muted-foreground space-y-1">
        {records
          .filter((record) => record.count > 0)
          .map((record) => (
            <div key={record.singular}>
              • {record.count}{" "}
              {record.count === 1 ? record.singular : record.plural}
            </div>
          ))}
        <div className="font-medium pt-1">
          Total: {total} {total === 1 ? "record" : "records"} will be updated
        </div>
      </div>
    </div>
  );
}

export function ModelReplacementDialog({
  isOpen,
  onClose,
  modelToDelete,
  availableModels,
  referenceCounts,
  onConfirm,
}: ModelReplacementDialogProps) {
  const [selectedReplacementId, setSelectedReplacementId] =
    useState<string>("");
  const [isReplacing, setIsReplacing] = useState(false);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);

  // Filter out the model being deleted and inactive models
  const replacementOptions = useMemo(() => {
    return availableModels.filter(
      (model) => model.id !== modelToDelete.id && model.active,
    );
  }, [availableModels, modelToDelete.id]);

  const selectedModel = useMemo(() => {
    return replacementOptions.find(
      (m) => m.id === Number(selectedReplacementId),
    );
  }, [replacementOptions, selectedReplacementId]);

  // Check for capability mismatches
  const handleSelectionChange = useCallback(
    (value: string) => {
      setSelectedReplacementId(value);
      const replacement = replacementOptions.find(
        (m) => m.id === Number(value),
      );
      setValidationWarnings(
        modelCompatibilityWarnings(modelToDelete, replacement),
      );
    },
    [modelToDelete, replacementOptions],
  );

  const handleConfirm = useCallback(async () => {
    if (!selectedReplacementId) return;

    setIsReplacing(true);
    try {
      await onConfirm(Number(selectedReplacementId));
      onClose();
    } finally {
      setIsReplacing(false);
    }
  }, [selectedReplacementId, onConfirm, onClose]);

  const handleClose = useCallback(() => {
    if (!isReplacing) {
      setSelectedReplacementId("");
      setValidationWarnings([]);
      onClose();
    }
  }, [isReplacing, onClose]);

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Replace Model References</DialogTitle>
          <DialogDescription>
            The model &ldquo;{modelToDelete.name}&rdquo; cannot be deleted
            because it has existing references. Select a replacement model to
            update all references before deletion.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <AffectedModelRecords counts={referenceCounts} />

          {/* Replacement model selection */}
          <div className="space-y-2">
            <label htmlFor="replacement-model" className="text-sm font-medium">
              Replacement Model
            </label>
            <Select
              value={selectedReplacementId}
              onValueChange={handleSelectionChange}
              disabled={isReplacing}
            >
              <SelectTrigger id="replacement-model">
                <SelectValue placeholder="Select a replacement model" />
              </SelectTrigger>
              <SelectContent>
                {replacementOptions.map((model) => (
                  <SelectItem key={model.id} value={model.id.toString()}>
                    <div className="flex items-center justify-between w-full">
                      <span>{model.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">
                        ({model.provider})
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedModel && (
              <p className="text-xs text-muted-foreground">
                Provider: {selectedModel.provider} | Nexus:{" "}
                {selectedModel.nexusEnabled ? "Enabled" : "Disabled"} |
                Architect:{" "}
                {selectedModel.architectEnabled ? "Enabled" : "Disabled"}
              </p>
            )}
          </div>

          {/* Warnings */}
          {validationWarnings.length > 0 && (
            <Alert className="border-yellow-200 bg-yellow-50">
              <AlertTriangle className="h-4 w-4 text-yellow-600" />
              <AlertDescription className="text-yellow-800">
                <div className="font-medium mb-1">Compatibility Warnings:</div>
                <ul className="list-disc list-inside text-sm space-y-1">
                  {validationWarnings.map((warning, idx) => (
                    <li key={idx}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Info message */}
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              This action will permanently delete &ldquo;{modelToDelete.name}
              &rdquo; and update all references to use the selected replacement
              model. This action cannot be undone.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isReplacing}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!selectedReplacementId || isReplacing}
          >
            {isReplacing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Replacing...
              </>
            ) : (
              "Replace and Delete"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
