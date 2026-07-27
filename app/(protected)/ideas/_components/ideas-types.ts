export type Idea = {
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

export type Note = {
  id: number;
  ideaId: number;
  content: string;
  createdBy: string;
  createdAt: Date;
};

export type SortMode = 'newest' | 'priority' | 'votes';

export interface IdeaFormData {
  title: string;
  description: string;
  priorityLevel: string;
}

export interface EditIdeaData extends IdeaFormData {
  id: number;
}
