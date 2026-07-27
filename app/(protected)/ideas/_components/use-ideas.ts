'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@/components/ui/use-toast';
import type {
  EditIdeaData,
  Idea,
  IdeaFormData,
  Note,
  SortMode,
} from './ideas-types';

const emptyIdeaForm: IdeaFormData = {
  title: '',
  description: '',
  priorityLevel: 'medium',
};

export function sortIdeas(ideas: Idea[], sortBy: SortMode): Idea[] {
  return [...ideas].sort((a, b) => {
    if (a.status === 'completed' && b.status !== 'completed') return 1;
    if (a.status !== 'completed' && b.status === 'completed') return -1;
    if (sortBy === 'votes') return b.votes - a.votes;
    if (sortBy === 'newest') {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
    const priorityOrder: Record<string, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    return (
      (priorityOrder[a.priorityLevel] ?? 3) -
      (priorityOrder[b.priorityLevel] ?? 3)
    );
  });
}

export function useIdeas() {
  const { toast } = useToast();
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [sortBy, setSortBy] = useState<SortMode>('newest');

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/ideas');
      if (!response.ok) throw new Error('Failed to fetch ideas');
      const data: unknown = await response.json();
      setIdeas(Array.isArray(data) ? (data as Idea[]) : []);
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to fetch ideas',
        variant: 'destructive',
      });
      setIdeas([]);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const vote = useCallback(async (ideaId: number) => {
    try {
      const response = await fetch(`/api/ideas/${ideaId}/vote`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error((await response.text()) || 'Failed to vote');
      }
      await response.json();
      await refresh();
      toast({
        title: 'Success',
        description: 'Vote recorded successfully',
        variant: 'default',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to vote',
        variant: 'destructive',
      });
    }
  }, [refresh, toast]);

  const changeStatus = useCallback(async (ideaId: number, status: string) => {
    try {
      const response = await fetch(`/api/ideas/${ideaId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error('Failed to update status');
      await refresh();
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to update status',
        variant: 'destructive',
      });
    }
  }, [refresh, toast]);

  const remove = useCallback(async (ideaId: number) => {
    try {
      const response = await fetch(`/api/ideas/${ideaId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete idea');
      await refresh();
      toast({
        title: 'Success',
        description: 'Idea deleted successfully',
        variant: 'default',
      });
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to delete idea',
        variant: 'destructive',
      });
    }
  }, [refresh, toast]);

  return {
    sortedIdeas: useMemo(() => sortIdeas(ideas, sortBy), [ideas, sortBy]),
    sortBy,
    setSortBy,
    refresh,
    vote,
    changeStatus,
    remove,
  };
}

export function useAddIdeaDialog(refresh: () => Promise<void>) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<IdeaFormData>(emptyIdeaForm);

  const submit = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (!response.ok) throw new Error('Failed to create idea');
      await refresh();
      setIsOpen(false);
      setFormData(emptyIdeaForm);
      toast({
        title: 'Success',
        description: 'Idea created successfully',
        variant: 'default',
      });
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to create idea',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [formData, refresh, toast]);

  return {
    isOpen,
    setIsOpen,
    open: () => setIsOpen(true),
    loading,
    formData,
    setFormData,
    submit,
  };
}

export function useIdeaNotesDialog() {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [newNote, setNewNote] = useState('');

  const open = useCallback(async (idea: Idea) => {
    setSelectedIdea(idea);
    try {
      const response = await fetch(`/api/ideas/${idea.id}/notes`);
      if (!response.ok) throw new Error('Failed to fetch notes');
      setNotes((await response.json()) as Note[]);
      setIsOpen(true);
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to fetch notes',
        variant: 'destructive',
      });
    }
  }, [toast]);

  const add = useCallback(async () => {
    if (!selectedIdea || !newNote.trim()) return;
    try {
      const response = await fetch(`/api/ideas/${selectedIdea.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newNote }),
      });
      if (!response.ok) throw new Error('Failed to add note');
      const addedNote = (await response.json()) as Note;
      setNotes((current) => [...current, addedNote]);
      setNewNote('');
      toast({
        title: 'Success',
        description: 'Note added successfully',
        variant: 'default',
      });
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to add note',
        variant: 'destructive',
      });
    }
  }, [newNote, selectedIdea, toast]);

  return {
    isOpen,
    setIsOpen,
    selectedIdea,
    notes,
    newNote,
    setNewNote,
    open,
    add,
  };
}

export function useEditIdeaDialog(refresh: () => Promise<void>) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [editData, setEditData] = useState<EditIdeaData>({
    ...emptyIdeaForm,
    id: 0,
  });

  const open = useCallback((idea: Idea) => {
    setSelectedIdea(idea);
    setEditData({
      id: idea.id,
      title: idea.title,
      description: idea.description,
      priorityLevel: idea.priorityLevel,
    });
    setIsOpen(true);
  }, []);

  const submit = useCallback(async () => {
    if (!selectedIdea) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/ideas/${selectedIdea.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editData),
      });
      if (!response.ok) throw new Error('Failed to update idea');
      await refresh();
      setIsOpen(false);
      toast({
        title: 'Success',
        description: 'Idea updated successfully',
        variant: 'default',
      });
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to update idea',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [editData, refresh, selectedIdea, toast]);

  return {
    isOpen,
    setIsOpen,
    loading,
    editData,
    setEditData,
    open,
    submit,
  };
}
