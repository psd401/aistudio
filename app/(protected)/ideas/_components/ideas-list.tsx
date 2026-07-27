'use client';

import {
  IconCheck,
  IconEdit,
  IconNote,
  IconThumbUp,
  IconTrash,
} from '@tabler/icons-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PageBranding } from '@/components/ui/page-branding';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Idea, SortMode } from './ideas-types';

export function IdeasHeader(props: {
  sortBy: SortMode;
  onSortChange: (sortBy: SortMode) => void;
  onAddIdea: () => void;
}) {
  return (
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
          <Select
            onValueChange={(value) => props.onSortChange(value as SortMode)}
            value={props.sortBy}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="priority">Priority</SelectItem>
              <SelectItem value="votes">Most Voted</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={props.onAddIdea}>Add Idea</Button>
        </div>
      </div>
    </div>
  );
}

function IdeaCard(props: {
  idea: Idea;
  onVote: (ideaId: number) => void;
  onOpenNotes: (idea: Idea) => void;
  onOpenEdit: (idea: Idea) => void;
  onComplete: (ideaId: number) => void;
  onDelete: (ideaId: number) => void;
}) {
  const { idea } = props;
  const priorityVariant =
    idea.priorityLevel === 'high'
      ? 'destructive'
      : idea.priorityLevel === 'medium'
        ? 'secondary'
        : 'outline';
  return (
    <Card
      className={`flex flex-col ${
        idea.status === 'completed' ? 'bg-gray-100' : ''
      }`}
    >
      <CardHeader>
        <CardTitle className="flex justify-between items-start">
          <span>{idea.title}</span>
          <Badge variant={priorityVariant}>{idea.priorityLevel}</Badge>
        </CardTitle>
        <CardDescription>
          Created by {idea.createdBy || 'Unknown'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-grow">
        <p>{idea.description}</p>
      </CardContent>
      <CardFooter className="flex flex-wrap justify-between items-center gap-2">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => props.onVote(idea.id)}
            className="flex items-center gap-1"
          >
            <IconThumbUp
              size={16}
              className={idea.hasVoted ? 'text-blue-500' : ''}
            />{' '}
            {idea.votes}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => props.onOpenNotes(idea)}
            className="flex items-center gap-1"
          >
            <IconNote size={16} /> {idea.notes}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => props.onOpenEdit(idea)}
          >
            <IconEdit size={16} />
          </Button>
          {idea.status !== 'completed' && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => props.onComplete(idea.id)}
            >
              <IconCheck size={16} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => props.onDelete(idea.id)}
          >
            <IconTrash size={16} />
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

export function IdeasList(props: {
  ideas: Idea[];
  onVote: (ideaId: number) => void;
  onOpenNotes: (idea: Idea) => void;
  onOpenEdit: (idea: Idea) => void;
  onComplete: (ideaId: number) => void;
  onDelete: (ideaId: number) => void;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <ScrollArea className="h-[calc(100vh-280px)]">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {props.ideas.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} {...props} />
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
