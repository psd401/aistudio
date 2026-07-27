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
import { RoomEditor, type RoomEditorFeedback } from "./room-editor";
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

export function RoomsManageClient({
  initialData,
}: {
  initialData: RoomsManageData;
}) {
  const router = useRouter();
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
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
    resetEditor();
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
    <div
      className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"
      data-testid="rooms-manage"
    >
      <RoomsList
        rooms={initialData.rooms}
        isAdministrator={initialData.isAdministrator}
        sectionById={sectionById}
        assistantById={assistantById}
        deletingRoomId={deletingRoomId}
        onCreate={resetEditor}
        onEdit={beginEdit}
        onDelete={deleteRoom}
      />
      <RoomEditor
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
        onCancel={resetEditor}
        onSubmit={saveRoom}
      />
    </div>
  );
}
