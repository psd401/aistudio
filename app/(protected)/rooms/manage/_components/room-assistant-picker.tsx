"use client";

import type { AccessibleAssistantOption } from "@/lib/rooms/queries";

interface RoomAssistantPickerProps {
  assistants: AccessibleAssistantOption[];
  selectedAssistantIds: number[];
  onToggle: (assistantId: number) => void;
}

export function RoomAssistantPicker({
  assistants,
  selectedAssistantIds,
  onToggle,
}: RoomAssistantPickerProps) {
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">Assigned assistants</legend>
      <p className="text-xs text-muted-foreground">
        Only approved assistants you can access are available.
      </p>
      {assistants.length === 0 ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          No accessible approved assistants are available.
        </p>
      ) : (
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-3">
          {assistants.map((assistant) => {
            const inputId = `room-assistant-input-${assistant.id}`;
            return (
              <div
                key={assistant.id}
                className="flex items-start gap-3 rounded-md p-2 hover:bg-muted/60"
              >
                <input
                  id={inputId}
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={selectedAssistantIds.includes(assistant.id)}
                  data-testid={`room-assistant-${assistant.id}`}
                  onChange={() => onToggle(assistant.id)}
                />
                <label htmlFor={inputId} className="cursor-pointer">
                  <span className="block text-sm font-medium">
                    {assistant.name}
                  </span>
                  {assistant.description && (
                    <span className="block text-xs text-muted-foreground">
                      {assistant.description}
                    </span>
                  )}
                </label>
              </div>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
