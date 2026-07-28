"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { SelectNavigationItem } from "@/types/db-types";
import { Button } from "@/components/ui/button";
import {
  GripVertical,
  Pencil,
  Trash,
  ChevronRight,
  ChevronDown,
  Link,
  FolderOpen,
  FileText,
  Eye,
  EyeOff,
} from "lucide-react";
import { NavigationItemForm } from "./navigation-item-form";
import { useState } from "react";
import { iconMap } from "@/components/navigation/icon-map";
import React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface NavigationItemProps {
  /** The navigation item to render */
  item: SelectNavigationItem;
  /** Callback function to trigger after updates */
  onUpdate: () => void;
  /** Whether the section is collapsed (only applicable for section type items) */
  isCollapsed?: boolean;
  /** Callback function to toggle section collapse state */
  onToggleCollapse?: () => void;
  /** Whether this item has children */
  hasChildren?: boolean;
}

function navigationTypeIcon(type: NavigationItemProps["item"]["type"]) {
  if (type === "section") return <FolderOpen className="h-3 w-3" />;
  if (type === "page") return <FileText className="h-3 w-3" />;
  return <Link className="h-3 w-3" />;
}

function NavigationCollapseToggle({
  item,
  hasChildren,
  isCollapsed,
  onToggleCollapse,
}: Pick<
  NavigationItemProps,
  "item" | "hasChildren" | "isCollapsed" | "onToggleCollapse"
>) {
  if (item.type !== "section" || !hasChildren) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      onClick={onToggleCollapse}
    >
      {isCollapsed ? (
        <ChevronRight className="h-4 w-4" />
      ) : (
        <ChevronDown className="h-4 w-4" />
      )}
    </Button>
  );
}

function NavigationItemDetails({ item }: Pick<NavigationItemProps, "item">) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="font-medium truncate">{item.label}</span>
        {!item.isActive && (
          <Badge variant="secondary" className="text-xs">
            Hidden
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          {navigationTypeIcon(item.type)}
          {item.type}
        </span>
        {item.link && (
          <>
            <span>•</span>
            <span className="truncate">{item.link}</span>
          </>
        )}
        {item.requiresRole && (
          <>
            <span>•</span>
            <Badge variant="outline" className="text-xs">
              {item.requiresRole}
            </Badge>
          </>
        )}
      </div>
    </div>
  );
}

function NavigationActiveIndicator({ active }: { active: boolean }) {
  return (
    <div className="absolute right-2 top-2">
      {active ? (
        <Eye className="h-3 w-3 text-muted-foreground" />
      ) : (
        <EyeOff className="h-3 w-3 text-muted-foreground" />
      )}
    </div>
  );
}

/**
 * Navigation Item Component
 *
 * Renders a draggable navigation item with the following features:
 * - Drag handle for reordering
 * - Icon display based on item type
 * - Collapse/expand functionality for sections
 * - Edit and delete actions
 * - Visual feedback during drag operations
 */
export function NavigationItem({
  item,
  onUpdate,
  isCollapsed = false,
  onToggleCollapse,
  hasChildren = false,
}: NavigationItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Configure drag-and-drop functionality
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  /**
   * Handles item deletion with confirmation
   */
  const handleDelete = async () => {
    if (
      confirm(
        "Are you sure you want to delete this navigation item? This action cannot be undone.",
      )
    ) {
      setIsDeleting(true);
      try {
        const response = await fetch(`/api/admin/navigation/${item.id}`, {
          method: "DELETE",
        });

        if (response.ok) {
          onUpdate();
        } else {
          const data = await response.json();
          alert(data.message || "Failed to delete navigation item");
        }
      } catch {
        alert("Failed to delete navigation item");
      } finally {
        setIsDeleting(false);
      }
    }
  };

  // Get the icon component from the icon map, fallback to home icon
  const IconComponent =
    iconMap[item.icon as keyof typeof iconMap] || iconMap.IconHome;

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          "group relative flex items-center gap-3 rounded-lg border bg-card p-3 transition-all hover:shadow-sm",
          isDragging && "shadow-lg",
          !item.isActive && "opacity-60",
        )}
      >
        {/* Drag handle */}
        <div
          className="cursor-grab opacity-0 transition-opacity group-hover:opacity-100"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-5 w-5 text-muted-foreground" />
        </div>

        <div className="flex flex-1 items-center gap-3">
          <NavigationCollapseToggle
            item={item}
            hasChildren={hasChildren}
            isCollapsed={isCollapsed}
            onToggleCollapse={onToggleCollapse}
          />

          {/* Item icon */}
          <div
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg",
              item.type === "section" ? "bg-primary/10" : "bg-muted",
            )}
          >
            {React.createElement(IconComponent, {
              className: cn(
                "h-5 w-5",
                item.type === "section"
                  ? "text-primary"
                  : "text-muted-foreground",
              ),
            })}
          </div>

          <NavigationItemDetails item={item} />
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setIsEditing(true)}
            title="Edit navigation item"
          >
            <Pencil className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            onClick={handleDelete}
            disabled={isDeleting}
            title="Delete navigation item"
          >
            <Trash className="h-4 w-4" />
          </Button>
        </div>

        <NavigationActiveIndicator active={item.isActive} />
      </div>

      {/* Edit form dialog */}
      <NavigationItemForm
        open={isEditing}
        onOpenChange={setIsEditing}
        onSubmit={() => {
          setIsEditing(false);
          onUpdate();
        }}
        initialData={item}
        items={[]}
      />
    </>
  );
}
