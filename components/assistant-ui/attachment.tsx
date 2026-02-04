"use client";

import { PropsWithChildren, useEffect, useState, startTransition, type FC } from "react";
import { CircleXIcon, FileIcon, PaperclipIcon, Loader2, CheckCircle2 } from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAttachment,
} from "@assistant-ui/react";
import { useShallow } from "zustand/shallow";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogTitle,
  DialogTrigger,
  DialogOverlay,
  DialogPortal,
} from "@/components/ui/dialog";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { DialogContent as DialogPrimitiveContent } from "@radix-ui/react-dialog";

const useFileSrc = (file: File | undefined) => {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      startTransition(() => { setSrc(undefined) });
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    startTransition(() => { setSrc(objectUrl) });

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return src;
};

const useAttachmentSrc = () => {
  const { file, src } = useAttachment(
    useShallow((a): { file?: File; src?: string } => {
      if (a.type !== "image") return {};
      if (a.file) return { file: a.file };
      const src = a.content?.find((c) => c.type === "image")?.image;
      if (!src) return {};
      return { src };
    }),
  );

  return useFileSrc(file) ?? src;
};

type AttachmentPreviewProps = {
  src: string;
};

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src }) => {
  const [isLoaded, setIsLoaded] = useState(false);

  return (
    <img
      src={src}
      style={{
        width: "auto",
        height: "auto",
        maxWidth: "75dvh",
        maxHeight: "75dvh",
        display: isLoaded ? "block" : "none",
        overflow: "clip",
      }}
      onLoad={() => setIsLoaded(true)}
      alt="Preview"
    />
  );
};

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const src = useAttachmentSrc();

  if (!src) return children;

  return (
    <Dialog>
      <DialogTrigger className="hover:bg-accent/50 cursor-pointer transition-colors" asChild>
        {children}
      </DialogTrigger>
      <AttachmentDialogContent>
        <DialogTitle className="sr-only">
          Image Attachment Preview
        </DialogTitle>
        <AttachmentPreview src={src} />
      </AttachmentDialogContent>
    </Dialog>
  );
};

const AttachmentThumb: FC = () => {
  const isImage = useAttachment((a) => a.type === "image");
  const src = useAttachmentSrc();
  return (
    <Avatar className="bg-muted flex size-10 items-center justify-center rounded border text-sm">
      <AvatarFallback delayMs={isImage ? 200 : 0}>
        <FileIcon />
      </AvatarFallback>
      <AvatarImage src={src} />
    </Avatar>
  );
};

interface AttachmentProcessingIndicatorProps {
  processingAttachments?: Set<string>;
}

const AttachmentProcessingIndicator: FC<AttachmentProcessingIndicatorProps> = ({ processingAttachments }) => {
  const attachmentId = useAttachment((a) => a.id);
  const attachmentType = useAttachment((a) => a.type);
  const attachmentSource = useAttachment((a) => a.source);
  const [showReady, setShowReady] = useState(false);
  const [wasProcessing, setWasProcessing] = useState(false);
  
  const isCurrentlyProcessing = processingAttachments?.has(attachmentId) || false;
  
  // Track when processing completes to show temporary "Ready" state
  useEffect(() => {
    if (isCurrentlyProcessing) {
      startTransition(() => { setWasProcessing(true) });
    } else if (wasProcessing && !isCurrentlyProcessing) {
      // Just completed processing
      startTransition(() => {
        setShowReady(true);
        setWasProcessing(false);
      });
      // Auto-hide "Ready" state after 2 seconds
      const timer = setTimeout(() => { setShowReady(false); }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isCurrentlyProcessing, wasProcessing]);
  
  // Only show processing indicators for documents (images process quickly)
  // And only in the composer, not in messages
  if (attachmentType !== "document" || attachmentSource === "message") return null;
  
  if (!isCurrentlyProcessing && !showReady) return null;
  
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/80 rounded-lg">
      {isCurrentlyProcessing && (
        <div className="flex flex-col items-center gap-1">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">Processing...</span>
        </div>
      )}
      {showReady && (
        <div className="flex flex-col items-center gap-1">
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          <span className="text-xs text-green-600">Ready</span>
        </div>
      )}
    </div>
  );
};

interface AttachmentUIProps {
  processingAttachments?: Set<string>;
}

const AttachmentUI: FC<AttachmentUIProps> = ({ processingAttachments }) => {
  const canRemove = useAttachment((a) => a.source !== "message");
  const typeLabel = useAttachment((a) => {
    const type = a.type;
    switch (type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default: {
        const _exhaustiveCheck: never = type;
        throw new Error(`Unknown attachment type: ${_exhaustiveCheck}`);
      }
    }
  });
  return (
    <Tooltip>
      <AttachmentPrimitive.Root className="relative mt-3">
        <AttachmentPreviewDialog>
          <TooltipTrigger asChild>
            <div className="flex h-12 w-40 items-center justify-center gap-2 rounded-lg border p-1 relative">
              <AttachmentThumb />
              <div className="flex-grow basis-0">
                <p className="text-muted-foreground line-clamp-1 text-ellipsis break-all text-xs font-bold">
                  <AttachmentPrimitive.Name />
                </p>
                <p className="text-muted-foreground text-xs">{typeLabel}</p>
              </div>
              <AttachmentProcessingIndicator processingAttachments={processingAttachments} />
            </div>
          </TooltipTrigger>
        </AttachmentPreviewDialog>
        {canRemove && <AttachmentRemove />}
      </AttachmentPrimitive.Root>
      <TooltipContent side="top">
        <AttachmentPrimitive.Name />
      </TooltipContent>
    </Tooltip>
  );
};

const AttachmentRemove: FC = () => {
  return (
    <AttachmentPrimitive.Remove asChild>
      <TooltipIconButton
        tooltip="Remove file"
        className="text-muted-foreground [&>svg]:bg-background absolute -right-3 -top-3 size-6 [&>svg]:size-4 [&>svg]:rounded-full"
        side="top"
      >
        <CircleXIcon />
      </TooltipIconButton>
    </AttachmentPrimitive.Remove>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div className="flex w-full flex-row gap-3 col-span-full col-start-1 row-start-1 justify-end">
      <MessagePrimitive.Attachments components={{ Attachment: AttachmentUI }} />
    </div>
  );
};

interface ComposerAttachmentsProps {
  processingAttachments?: Set<string>;
}

export const ComposerAttachments: FC<ComposerAttachmentsProps> = ({ processingAttachments }) => {
  const AttachmentWithProcessing = (props: Record<string, unknown>) => <AttachmentUI {...props} processingAttachments={processingAttachments} />;
  
  return (
    <div className="flex w-full flex-row gap-3 overflow-x-auto">
      <ComposerPrimitive.Attachments
        components={{ Attachment: AttachmentWithProcessing }}
      />
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        className="my-2.5 size-8 p-2 transition-opacity ease-in"
        tooltip="Add Attachment"
        variant="ghost"
      >
        <PaperclipIcon />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
};

const AttachmentDialogContent: FC<PropsWithChildren> = ({ children }) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitiveContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] fixed left-[50%] top-[50%] z-50 grid translate-x-[-50%] translate-y-[-50%] shadow-lg duration-200">
      {children}
    </DialogPrimitiveContent>
  </DialogPortal>
);
