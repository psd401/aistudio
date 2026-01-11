'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/ui/use-toast';
import { IconThumbUp, IconNote, IconCheck, IconTrash, IconEdit } from '@tabler/icons-react';
import { PageBranding } from '@/components/ui/page-branding';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type Idea = {
  id: number;
  title: string;
  description: string;
  priorityLevel: string;
  status: string;
  votes: number;
  notes: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  completedBy?: string;
  hasVoted?: boolean;
};

type Note = {
  id: number;
  ideaId: number;
  content: string;
  createdBy: string;
  createdAt: Date;
};

export default function IdeasPage() {
  const { toast } = useToast();
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [sortBy, setSortBy] = useState<'newest' | 'priority' | 'votes'>('newest');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showNotesDialog, setShowNotesDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [newNote, setNewNote] = useState('');
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    priorityLevel: 'medium',
  });
  const [editData, setEditData] = useState({
    id: 0,
    title: '',
    description: '',
    priorityLevel: '',
  });

  // Moved useEffect after fetchIdeas declaration

  const sortIdeas = (ideasToSort: Idea[]) => {
    return [...ideasToSort].sort((a, b) => {
      // First sort by completion status
      if (a.status === 'completed' && b.status !== 'completed') return 1;
      if (a.status !== 'completed' && b.status === 'completed') return -1;
      
      // Then apply the selected sort within each group
      switch (sortBy) {
        case 'priority': {
          const priorityOrder = { high: 0, medium: 1, low: 2 };
          return (priorityOrder[a.priorityLevel as keyof typeof priorityOrder] || 3) -
                 (priorityOrder[b.priorityLevel as keyof typeof priorityOrder] || 3);
        }
        case 'votes':
          return b.votes - a.votes;
        case 'newest':
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });
  };

  const fetchIdeas = useCallback(async () => {
    try {
      const response = await fetch('/api/ideas');
      if (!response.ok) {
        throw new Error('Failed to fetch ideas');
      }
      const data = await response.json();
      setIdeas(Array.isArray(data) ? data : []);
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
    fetchIdeas();
  }, [fetchIdeas]);

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/ideas', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });
      
      if (!response.ok) throw new Error('Failed to create idea');
      
      await fetchIdeas();
      setShowAddDialog(false);
      setFormData({ title: '', description: '', priorityLevel: 'medium' });
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
  };

  const handleVote = async (ideaId: number) => {
    try {
      
      const response = await fetch(`/api/ideas/${ideaId}/vote`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Failed to vote');
      }
      
      await response.json();
      
      await fetchIdeas();
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
  };

  const handleStatusChange = async (ideaId: number, status: string) => {
    try {
      const response = await fetch(`/api/ideas/${ideaId}/status`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error('Failed to update status');
      await fetchIdeas();
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to update status',
        variant: 'destructive',
      });
    }
  };

  const handleOpenNotes = async (idea: Idea) => {
    setSelectedIdea(idea);
    try {
      const response = await fetch(`/api/ideas/${idea.id}/notes`);
      if (!response.ok) throw new Error('Failed to fetch notes');
      const data = await response.json();
      setNotes(data);
      setShowNotesDialog(true);
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to fetch notes',
        variant: 'destructive',
      });
    }
  };

  const handleAddNote = async () => {
    if (!selectedIdea || !newNote.trim()) return;

    try {
      const response = await fetch(`/api/ideas/${selectedIdea.id}/notes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: newNote }),
      });
      
      if (!response.ok) throw new Error('Failed to add note');
      
      const addedNote = await response.json();
      setNotes([...notes, addedNote]);
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
  };

  const handleEdit = async () => {
    if (!selectedIdea) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/ideas/${selectedIdea.id}`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(editData),
      });
      
      if (!response.ok) throw new Error('Failed to update idea');
      
      await fetchIdeas();
      setShowEditDialog(false);
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
  };

  const handleOpenEdit = (idea: Idea) => {
    setSelectedIdea(idea);
    setEditData({
      id: idea.id,
      title: idea.title,
      description: idea.description,
      priorityLevel: idea.priorityLevel,
    });
    setShowEditDialog(true);
  };

  const handleDelete = async (ideaId: number) => {
    try {
      const response = await fetch(`/api/ideas/${ideaId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete idea');
      await fetchIdeas();
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
  };

  return (
    <>
      <div className="mb-6">
        <PageBranding />
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Ideas</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Share and vote on ideas for improving our tools
            </p>
          </div>
          <div className="flex items-center gap-4">
          <Select onValueChange={(value) => setSortBy(value as 'newest' | 'priority' | 'votes')} value={sortBy}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="priority">Priority</SelectItem>
              <SelectItem value="votes">Most Voted</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={() => setShowAddDialog(true)}>Add Idea</Button>
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <ScrollArea className="h-[calc(100vh-280px)]">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sortIdeas(ideas).map((idea) => (
            <Card key={idea.id} className={`flex flex-col ${idea.status === 'completed' ? 'bg-gray-100' : ''}`}>
              <CardHeader>
                <CardTitle className="flex justify-between items-start">
                  <span>{idea.title}</span>
                  <Badge 
                    variant={
                      idea.priorityLevel === 'high' ? 'destructive' :
                      idea.priorityLevel === 'medium' ? 'secondary' : 'outline'
                    }
                  >
                    {idea.priorityLevel}
                  </Badge>
                </CardTitle>
                <CardDescription>Created by {idea.createdBy || 'Unknown'}</CardDescription>
              </CardHeader>
              <CardContent className="flex-grow">
                <p>{idea.description}</p>
              </CardContent>
              <CardFooter className="flex flex-wrap justify-between items-center gap-2">
                <div className="flex items-center gap-4">
                  <Button variant="ghost" size="sm" onClick={() => handleVote(idea.id)} className="flex items-center gap-1">
                    <IconThumbUp size={16} className={idea.hasVoted ? 'text-blue-500' : ''}/> {idea.votes}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleOpenNotes(idea)} className="flex items-center gap-1">
                    <IconNote size={16} /> {idea.notes}
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(idea)}>
                    <IconEdit size={16} />
                  </Button>
                  {idea.status !== 'completed' && (
                    <Button variant="ghost" size="icon" onClick={() => handleStatusChange(idea.id, 'completed')}>
                      <IconCheck size={16} />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(idea.id)}>
                    <IconTrash size={16} />
                  </Button>
                </div>
              </CardFooter>
            </Card>
            ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Idea</DialogTitle>
            <DialogDescription>
              Share your idea for improving our tools.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="idea-title" className="text-sm font-medium">Title</label>
              <Input
                id="idea-title"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="Enter idea title"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="idea-description" className="text-sm font-medium">Description</label>
              <Textarea
                id="idea-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe your idea"
                rows={4}
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium" aria-label="Priority level">Priority Level</div>
              <Select
                value={formData.priorityLevel}
                onValueChange={(value) => setFormData({ ...formData, priorityLevel: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={loading}>
              {loading ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                'Submit'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showNotesDialog} onOpenChange={setShowNotesDialog}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Notes</DialogTitle>
            <DialogDescription>
              {selectedIdea?.title}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-4">
            {notes.map((note) => (
              <Card key={note.id}>
                <CardContent className="pt-6">
                  <p className="text-sm break-words whitespace-pre-wrap">{note.content}</p>
                  <p className="text-xs text-muted-foreground mt-2">
                    {new Date(note.createdAt).toLocaleString()} by {note.createdBy}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="flex gap-2 pt-4 border-t mt-4">
            <Textarea
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="Add a note..."
              className="flex-1"
            />
            <Button onClick={handleAddNote}>Add</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Idea</DialogTitle>
            <DialogDescription>
              Make changes to your idea here. Click save when you&apos;re done.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Input
              placeholder="Title"
              value={editData.title}
              onChange={(e) => setEditData({ ...editData, title: e.target.value })}
            />
            <Textarea
              placeholder="Description"
              value={editData.description}
              onChange={(e) => setEditData({ ...editData, description: e.target.value })}
            />
            <Select
              value={editData.priorityLevel}
              onValueChange={(value) => setEditData({ ...editData, priorityLevel: value })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button onClick={handleEdit} disabled={loading}>{loading ? 'Saving...' : 'Save Changes'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
} 