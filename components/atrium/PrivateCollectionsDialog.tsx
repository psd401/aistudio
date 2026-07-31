"use client";

import { FolderCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CollectionManagementPanel } from "./CollectionManagementPanel";
import { meridianPortalClassName } from "@/lib/atrium/meridian-fonts";

export function PrivateCollectionsDialog(): React.JSX.Element {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <FolderCog className="mr-1 h-4 w-4" />
          New private collection
        </Button>
      </DialogTrigger>
      <DialogContent
        className={`max-h-[90vh] max-w-5xl overflow-y-auto ${meridianPortalClassName}`}
        // Meridian caps plain dialogs at 520px (base DialogContent ships no
        // max-width). This one genuinely needs the room, so it opts into the
        // shared size scale rather than fighting the cap with max-w-5xl alone.
        // NOT data-wide-mode — that attribute is owned by DialogContent's
        // `wide` prop and pairs with inline 95vw/90vh styles; setting it by
        // hand desyncs the two.
        data-mer-size="xwide"
      >
        <DialogHeader>
          <DialogTitle>Manage private collections</DialogTitle>
          <DialogDescription>
            Create, nest, rename, move, reorder, archive, and restore collections
            that remain bound to your account.
          </DialogDescription>
        </DialogHeader>
        <CollectionManagementPanel mode="private" />
      </DialogContent>
    </Dialog>
  );
}
