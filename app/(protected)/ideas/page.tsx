'use client';

import {
  AddIdeaDialog,
  EditIdeaDialog,
  IdeaNotesDialog,
} from './_components/idea-dialogs';
import { IdeasHeader, IdeasList } from './_components/ideas-list';
import {
  useAddIdeaDialog,
  useEditIdeaDialog,
  useIdeaNotesDialog,
  useIdeas,
} from './_components/use-ideas';

export default function IdeasPage() {
  const ideas = useIdeas();
  const addDialog = useAddIdeaDialog(ideas.refresh);
  const notesDialog = useIdeaNotesDialog();
  const editDialog = useEditIdeaDialog(ideas.refresh);

  return (
    <>
      <IdeasHeader
        sortBy={ideas.sortBy}
        onSortChange={ideas.setSortBy}
        onAddIdea={addDialog.open}
      />
      <IdeasList
        ideas={ideas.sortedIdeas}
        onVote={ideas.vote}
        onOpenNotes={notesDialog.open}
        onOpenEdit={editDialog.open}
        onComplete={(ideaId) => ideas.changeStatus(ideaId, 'completed')}
        onDelete={ideas.remove}
      />
      <AddIdeaDialog controller={addDialog} />
      <IdeaNotesDialog controller={notesDialog} />
      <EditIdeaDialog controller={editDialog} />
    </>
  );
}
