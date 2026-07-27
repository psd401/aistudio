"use client";

import type { TeacherSectionOption } from "@/lib/rooms/queries";

interface RoomSectionPickerProps {
  sections: TeacherSectionOption[];
  selectedSectionIds: string[];
  onToggle: (sectionId: string) => void;
}

export function RoomSectionPicker({
  sections,
  selectedSectionIds,
  onToggle,
}: RoomSectionPickerProps) {
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">Your ClassLink sections</legend>
      <p className="text-xs text-muted-foreground">
        Membership follows active student enrollments automatically.
      </p>
      {sections.length === 0 ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          No active teacher sections match your email.
        </p>
      ) : (
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-3">
          {sections.map((section) => {
            const inputId = `room-section-input-${section.sourcedId}`;
            return (
              <div
                key={section.sourcedId}
                className="flex items-start gap-3 rounded-md p-2 hover:bg-muted/60"
              >
                <input
                  id={inputId}
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  data-testid={`room-section-${section.sourcedId}`}
                  checked={selectedSectionIds.includes(section.sourcedId)}
                  onChange={() => onToggle(section.sourcedId)}
                />
                <label htmlFor={inputId} className="cursor-pointer">
                  <span className="block text-sm font-medium">
                    {section.title ?? section.sourcedId}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {[section.classCode, section.schoolName]
                      .filter(Boolean)
                      .join(" · ")}{" "}
                    · {section.studentCount} students
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
