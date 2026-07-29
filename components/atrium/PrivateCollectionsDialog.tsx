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

export function PrivateCollectionsDialog(): React.JSX.Element {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <FolderCog className="mr-1 h-4 w-4" />
          New private collection
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
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
