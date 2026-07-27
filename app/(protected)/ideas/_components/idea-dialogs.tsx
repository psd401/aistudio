'use client';

import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type {
  EditIdeaData,
  Idea,
  IdeaFormData,
  Note,
} from './ideas-types';

function PrioritySelect(props: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={props.value} onValueChange={props.onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Select priority" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="low">Low</SelectItem>
        <SelectItem value="medium">Medium</SelectItem>
        <SelectItem value="high">High</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function AddIdeaDialog(props: {
  controller: {
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
    loading: boolean;
    formData: IdeaFormData;
    setFormData: Dispatch<SetStateAction<IdeaFormData>>;
    submit: () => Promise<void>;
  };
}) {
  const controller = props.controller;
  return (
    <Dialog open={controller.isOpen} onOpenChange={controller.setIsOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Idea</DialogTitle>
          <DialogDescription>
            Share your idea for improving our tools.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="idea-title" className="text-sm font-medium">
              Title
            </label>
            <Input
              id="idea-title"
              value={controller.formData.title}
              onChange={(event) =>
                controller.setFormData((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              placeholder="Enter idea title"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="idea-description" className="text-sm font-medium">
              Description
            </label>
            <Textarea
              id="idea-description"
              value={controller.formData.description}
              onChange={(event) =>
                controller.setFormData((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              placeholder="Describe your idea"
              rows={4}
            />
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium" aria-label="Priority level">
              Priority Level
            </div>
            <PrioritySelect
              value={controller.formData.priorityLevel}
              onChange={(priorityLevel) =>
                controller.setFormData((current) => ({
                  ...current,
                  priorityLevel,
                }))
              }
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => controller.setIsOpen(false)}
          >
            Cancel
          </Button>
          <Button onClick={controller.submit} disabled={controller.loading}>
            {controller.loading ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              'Submit'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function IdeaNotesDialog(props: {
  controller: {
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
    selectedIdea: Idea | null;
    notes: Note[];
    newNote: string;
    setNewNote: (note: string) => void;
    add: () => Promise<void>;
  };
}) {
  const controller = props.controller;
  return (
    <Dialog open={controller.isOpen} onOpenChange={controller.setIsOpen}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Notes</DialogTitle>
          <DialogDescription>
            {controller.selectedIdea?.title}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-4">
          {controller.notes.map((note) => (
            <Card key={note.id}>
              <CardContent className="pt-6">
                <p className="text-sm break-words whitespace-pre-wrap">
                  {note.content}
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                  {new Date(note.createdAt).toLocaleString()} by {note.createdBy}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="flex gap-2 pt-4 border-t mt-4">
          <Textarea
            value={controller.newNote}
            onChange={(event) => controller.setNewNote(event.target.value)}
            placeholder="Add a note..."
            className="flex-1"
          />
          <Button onClick={controller.add}>Add</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function EditIdeaDialog(props: {
  controller: {
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
    loading: boolean;
    editData: EditIdeaData;
    setEditData: Dispatch<SetStateAction<EditIdeaData>>;
    submit: () => Promise<void>;
  };
}) {
  const controller = props.controller;
  return (
    <Dialog open={controller.isOpen} onOpenChange={controller.setIsOpen}>
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
            value={controller.editData.title}
            onChange={(event) =>
              controller.setEditData((current) => ({
                ...current,
                title: event.target.value,
              }))
            }
          />
          <Textarea
            placeholder="Description"
            value={controller.editData.description}
            onChange={(event) =>
              controller.setEditData((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
          />
          <PrioritySelect
            value={controller.editData.priorityLevel}
            onChange={(priorityLevel) =>
              controller.setEditData((current) => ({
                ...current,
                priorityLevel,
              }))
            }
          />
        </div>
        <DialogFooter>
          <Button onClick={controller.submit} disabled={controller.loading}>
            {controller.loading ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
