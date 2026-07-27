"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import type {
  AccessibleAssistantOption,
  ManagedRoom,
  TeacherSectionOption,
} from "@/lib/rooms/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface RoomsListProps {
  rooms: ManagedRoom[];
  sectionById: ReadonlyMap<string, TeacherSectionOption>;
  assistantById: ReadonlyMap<number, AccessibleAssistantOption>;
  deletingRoomId: string | null;
  onCreate: () => void;
  onEdit: (room: ManagedRoom) => void;
  onDelete: (roomId: string) => void;
}

export function RoomsList({
  rooms,
  sectionById,
  assistantById,
  deletingRoomId,
  onCreate,
  onEdit,
  onDelete,
}: RoomsListProps) {
  return (
    <section className="space-y-4" aria-labelledby="my-rooms-heading">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="my-rooms-heading" className="text-lg font-semibold">
            My rooms
          </h2>
          <p className="text-sm text-muted-foreground">
            {rooms.length} active room{rooms.length === 1 ? "" : "s"}
          </p>
        </div>
        <Button type="button" onClick={onCreate} data-testid="room-create-new">
          <Plus className="mr-2 h-4 w-4" />
          New room
        </Button>
      </div>

      {rooms.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No rooms yet. Create one from your synced ClassLink sections.
          </CardContent>
        </Card>
      ) : (
        rooms.map((room) => (
          <Card key={room.id} data-testid={`room-card-${room.id}`}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{room.name}</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {room.classSourcedIds.length} section
                    {room.classSourcedIds.length === 1 ? "" : "s"} ·{" "}
                    {room.memberEmails.length} explicit student
                    {room.memberEmails.length === 1 ? "" : "s"} ·{" "}
                    {room.assistantIds.length} assistant
                    {room.assistantIds.length === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${room.name}`}
                    onClick={() => onEdit(room)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${room.name}`}
                    disabled={deletingRoomId === room.id}
                    onClick={() => onDelete(room.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {room.classSourcedIds.map((id) => (
                <Badge key={id} variant="secondary">
                  {sectionById.get(id)?.title ?? id}
                </Badge>
              ))}
              {room.assistantIds.map((id) => (
                <Badge key={id} variant="outline">
                  {assistantById.get(id)?.name ?? `Assistant ${id}`}
                </Badge>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </section>
  );
}
