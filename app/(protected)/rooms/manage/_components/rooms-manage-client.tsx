"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createRoomAction,
  deleteRoomAction,
  searchRoomStudentsAction,
  updateRoomAction,
  type RoomsManageData,
} from "@/actions/db/rooms-actions";
import type { RoomMutationInput } from "@/lib/rooms/mutations";
import type { ManagedRoom, RosterStudentOption } from "@/lib/rooms/queries";
import { RoomEditorDialog, type RoomEditorFeedback } from "./room-editor";
import { RoomsList } from "./rooms-list";

const emptyDraft = (): RoomMutationInput => ({
  name: "",
  classSourcedIds: [],
  memberEmails: [],
  assistantIds: [],
});

function roomToDraft(room: ManagedRoom): RoomMutationInput {
  return {
    name: room.name,
    classSourcedIds: [...room.classSourcedIds],
    memberEmails: [...room.memberEmails],
    assistantIds: [...room.assistantIds],
  };
}

/**
 * Success feedback has to live on the PAGE, not in the editor: the editor is a
 * modal now and closes on a successful save, so a banner rendered inside it
 * would unmount before it could be read. Errors keep rendering inside the modal,
 * which stays open so the form can be corrected — hence `hidden` rather than
 * moving the banner wholesale.
 */
function RoomFeedbackBanner({
  feedback,
  hidden,
}: {
  feedback: RoomEditorFeedback | null;
  hidden: boolean;
}) {
  if (!feedback || hidden) return null;
  return (
    <div
      data-testid="room-feedback"
      role="status"
      className={
        feedback.kind === "error"
          ? "rounded-[var(--mer-r-button,0.375rem)] border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          : "rounded-[var(--mer-r-button,0.375rem)] border border-border bg-muted px-4 py-3 text-sm"
      }
    >
      {feedback.message}
    </div>
  );
}

export function RoomsManageClient({
  initialData,
}: {
  initialData: RoomsManageData;
}) {
  const router = useRouter();
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  // The editor used to live permanently in a right-hand column, so "New room"
  // (which only resets the draft) produced no visible change and read as a dead
  // button. It is a modal now: the click has an unmistakable result, and the
  // list gets the full width.
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [draft, setDraft] = useState<RoomMutationInput>(emptyDraft);
  const [studentSearch, setStudentSearch] = useState("");
  const [studentResults, setStudentResults] = useState<RosterStudentOption[]>([]);
  const [feedback, setFeedback] = useState<RoomEditorFeedback | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [deletingRoomId, setDeletingRoomId] = useState<string | null>(null);
  const sectionById = useMemo(
    () =>
      new Map(
        initialData.sections.map((section) => [section.sourcedId, section])
      ),
    [initialData.sections]
  );
  const assistantById = useMemo(
    () =>
      new Map(
        initialData.assistants.map((assistant) => [assistant.id, assistant])
      ),
    [initialData.assistants]
  );

  function openCreate() {
    resetEditor();
    setIsEditorOpen(true);
  }

  function closeEditor() {
    setIsEditorOpen(false);
    resetEditor();
  }

  function resetEditor() {
    setEditingRoomId(null);
    setDraft(emptyDraft());
    setStudentResults([]);
    setStudentSearch("");
    setFeedback(null);
  }

  function beginEdit(room: ManagedRoom) {
    resetEditor();
    setEditingRoomId(room.id);
    setDraft(roomToDraft(room));
    setIsEditorOpen(true);
  }

  async function searchStudents() {
    setIsSearching(true);
    setFeedback(null);
    const result = await searchRoomStudentsAction(studentSearch);
    setIsSearching(false);
    if (!result.isSuccess || !result.data) {
      setStudentResults([]);
      setFeedback({
        kind: "error",
        message: result.message ?? "Student search failed.",
      });
      return;
    }
    setStudentResults(result.data);
  }

  function addStudent(student: RosterStudentOption) {
    if (!draft.memberEmails.includes(student.email)) {
      setDraft((current) => ({
        ...current,
        memberEmails: [...current.memberEmails, student.email],
      }));
    }
  }

  async function saveRoom(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setFeedback(null);
    const result = editingRoomId
      ? await updateRoomAction(editingRoomId, draft)
      : await createRoomAction(draft);
    setIsSaving(false);
    if (!result.isSuccess) {
      setFeedback({
        kind: "error",
        message: result.message ?? "Room could not be saved.",
      });
      return;
    }
    closeEditor();
    setFeedback({ kind: "success", message: result.message ?? "Room saved." });
    router.refresh();
  }

  async function deleteRoom(roomId: string) {
    setDeletingRoomId(roomId);
    setFeedback(null);
    const result = await deleteRoomAction(roomId);
    setDeletingRoomId(null);
    if (!result.isSuccess) {
      setFeedback({
        kind: "error",
        message: result.message ?? "Room could not be deleted.",
      });
      return;
    }
    if (editingRoomId === roomId) resetEditor();
    setFeedback({ kind: "success", message: result.message ?? "Room deleted." });
    router.refresh();
  }

  return (
    <div className="space-y-6" data-testid="rooms-manage">
      <RoomFeedbackBanner feedback={feedback} hidden={isEditorOpen} />

      <RoomsList
        rooms={initialData.rooms}
        isAdministrator={initialData.isAdministrator}
        sectionById={sectionById}
        assistantById={assistantById}
        deletingRoomId={deletingRoomId}
        onCreate={openCreate}
        onEdit={beginEdit}
        onDelete={deleteRoom}
      />
      <RoomEditorDialog
        open={isEditorOpen}
        onOpenChange={(open) => (open ? setIsEditorOpen(true) : closeEditor())}
        editingRoomId={editingRoomId}
        draft={draft}
        sections={initialData.sections}
        assistants={initialData.assistants}
        studentSearch={studentSearch}
        studentResults={studentResults}
        feedback={feedback}
        isSaving={isSaving}
        isSearching={isSearching}
        onDraftChange={setDraft}
        onStudentSearchChange={setStudentSearch}
        onStudentSearch={searchStudents}
        onAddStudent={addStudent}
        onCancel={closeEditor}
        onSubmit={saveRoom}
      />
    </div>
  );
}
