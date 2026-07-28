"use client";

import type { FormEvent } from "react";
import type { RoomMutationInput } from "@/lib/rooms/mutations";
import type {
  AccessibleAssistantOption,
  RosterStudentOption,
  TeacherSectionOption,
} from "@/lib/rooms/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { RoomAssistantPicker } from "./room-assistant-picker";
import { RoomSectionPicker } from "./room-section-picker";
import { RoomStudentPicker } from "./room-student-picker";

export interface RoomEditorFeedback {
  kind: "success" | "error";
  message: string;
}

interface RoomEditorProps {
  editingRoomId: string | null;
  draft: RoomMutationInput;
  sections: TeacherSectionOption[];
  assistants: AccessibleAssistantOption[];
  studentSearch: string;
  studentResults: RosterStudentOption[];
  feedback: RoomEditorFeedback | null;
  isSaving: boolean;
  isSearching: boolean;
  onDraftChange: (draft: RoomMutationInput) => void;
  onStudentSearchChange: (value: string) => void;
  onStudentSearch: () => void;
  onAddStudent: (student: RosterStudentOption) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function RoomEditor(props: RoomEditorProps) {
  const updateDraft = (changes: Partial<RoomMutationInput>) =>
    props.onDraftChange({ ...props.draft, ...changes });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {props.editingRoomId ? "Edit room" : "Create a room"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={props.onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="room-name">Room name</Label>
            <Input
              id="room-name"
              data-testid="room-name"
              value={props.draft.name}
              maxLength={120}
              required
              onChange={(event) => updateDraft({ name: event.target.value })}
              placeholder="Period 2 Biology"
            />
          </div>
          <Separator />
          <RoomSectionPicker
            sections={props.sections}
            selectedSectionIds={props.draft.classSourcedIds}
            onToggle={(sectionId) =>
              updateDraft({
                classSourcedIds: toggleValue(
                  props.draft.classSourcedIds,
                  sectionId
                ),
              })
            }
          />
          <Separator />
          <RoomStudentPicker
            search={props.studentSearch}
            results={props.studentResults}
            memberEmails={props.draft.memberEmails}
            isSearching={props.isSearching}
            onSearchChange={props.onStudentSearchChange}
            onSearch={props.onStudentSearch}
            onAdd={props.onAddStudent}
            onRemove={(email) =>
              updateDraft({
                memberEmails: props.draft.memberEmails.filter(
                  (value) => value !== email
                ),
              })
            }
          />
          <Separator />
          <RoomAssistantPicker
            assistants={props.assistants}
            selectedAssistantIds={props.draft.assistantIds}
            onToggle={(assistantId) =>
              updateDraft({
                assistantIds: toggleValue(
                  props.draft.assistantIds,
                  assistantId
                ),
              })
            }
          />
          {props.feedback && (
            <p
              role="status"
              className={
                props.feedback.kind === "success"
                  ? "text-sm text-emerald-700"
                  : "text-sm text-destructive"
              }
              data-testid="room-feedback"
            >
              {props.feedback.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            {props.editingRoomId && (
              <Button type="button" variant="outline" onClick={props.onCancel}>
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              disabled={props.isSaving}
              data-testid="room-save"
            >
              {props.isSaving
                ? "Saving…"
                : props.editingRoomId
                  ? "Save changes"
                  : "Create room"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}
