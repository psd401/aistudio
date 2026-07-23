"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";
import type {
  TextMessagePartComponent,
  TextMessagePartProps,
} from "@assistant-ui/react";
import {
  BookMarkedIcon,
  CheckCircle2,
  FileIcon,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Button } from "@/components/ui/button";
import { createLogger } from "@/lib/client-logger";
import {
  parseTemporaryAttachmentMarkers,
  removeTemporaryAttachmentMarkers,
  type TemporaryAttachmentReference,
} from "@/lib/repositories/temporary-attachment-contract";
import { cn } from "@/lib/utils";

const log = createLogger({ module: "repository-attachment-message" });

const RepositoryPromotionAccessContext = createContext(false);

export const RepositoryPromotionAccessProvider: FC<{
  canPromote: boolean;
  children: ReactNode;
}> = ({ canPromote, children }) => (
  <RepositoryPromotionAccessContext.Provider value={canPromote}>
    {children}
  </RepositoryPromotionAccessContext.Provider>
);

interface RepositoryPromotionButtonProps {
  reference: TemporaryAttachmentReference;
  attachmentName: string;
  compact?: boolean;
  className?: string;
}

export const RepositoryPromotionButton: FC<
  RepositoryPromotionButtonProps
> = ({ reference, attachmentName, compact = false, className }) => {
  const canPromote = useContext(RepositoryPromotionAccessContext);
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState(false);

  const promote = async () => {
    if (promoting || promoted) return;
    setPromoting(true);
    try {
      const repositoryName =
        attachmentName.replace(/\.[^.]+$/, "").trim() ||
        "Saved Nexus attachment";
      const response = await fetch(
        `/api/repositories/temporary-attachments/${reference.bindingId}/${reference.itemId}/promote`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: repositoryName }),
        }
      );
      if (!response.ok) {
        throw new Error("Temporary attachment could not be kept");
      }
      setPromoted(true);
      toast.success("Attachment kept as a permanent private repository.");
    } catch (error) {
      log.warn("Repository attachment promotion failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      toast.error("Could not keep this attachment permanently.");
    } finally {
      setPromoting(false);
    }
  };

  const label = promoted ? "Saved as a repository" : "Keep as a repository";

  if (!canPromote) return null;

  return (
    <Button
      type="button"
      variant={compact ? "ghost" : "outline"}
      size={compact ? "icon" : "sm"}
      className={cn(compact && "size-7", className)}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void promote();
      }}
      disabled={promoting || promoted}
      aria-label={label}
      title={label}
    >
      {promoting ? (
        <Loader2 className="size-4 animate-spin" />
      ) : promoted ? (
        <CheckCircle2 className="size-4" />
      ) : (
        <BookMarkedIcon className="size-4" />
      )}
      {!compact && <span>{label}</span>}
    </Button>
  );
};

const RepositoryAttachmentCard: FC<{
  reference: TemporaryAttachmentReference;
}> = ({ reference }) => (
  <div className="flex min-w-0 items-center gap-2 rounded-xl border bg-background/70 p-2">
    <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
      <FileIcon className="size-4" aria-hidden="true" />
    </div>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{reference.name}</p>
      <p className="text-muted-foreground text-xs">
        Temporary repository attachment
      </p>
    </div>
    <RepositoryPromotionButton
      reference={reference}
      attachmentName={reference.name}
    />
  </div>
);

/**
 * User messages retain opaque canonical references so "keep later" survives a
 * conversation reload. Render those references as attachment cards and never
 * expose the marker syntax in the visible transcript.
 */
export const RepositoryAwareUserMessageText: TextMessagePartComponent = ({
  text,
}: TextMessagePartProps) => {
  const references = useMemo(
    () => parseTemporaryAttachmentMarkers(text),
    [text]
  );
  const visibleText = useMemo(
    () => removeTemporaryAttachmentMarkers(text).trim(),
    [text]
  );

  if (references.length === 0) {
    return <MarkdownText />;
  }

  return (
    <div className="flex min-w-[18rem] flex-col gap-2">
      {visibleText && <p className="whitespace-pre-wrap">{visibleText}</p>}
      <div className="flex flex-col gap-2">
        {references.map((reference) => (
          <RepositoryAttachmentCard
            key={`${reference.bindingId}:${reference.itemId}`}
            reference={reference}
          />
        ))}
      </div>
    </div>
  );
};
