import { describe, expect, it } from 'bun:test';
import { sortIdeas } from '@/app/(protected)/ideas/_components/use-ideas';
import type { Idea } from '@/app/(protected)/ideas/_components/ideas-types';

function createIdea(overrides: Partial<Idea>): Idea {
  return {
    id: 1,
    title: 'Idea',
    description: 'Description',
    priorityLevel: 'medium',
    status: 'open',
    votes: 0,
    notes: 0,
    createdBy: 'User',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('sortIdeas', () => {
  const ideas = [
    createIdea({
      id: 1,
      priorityLevel: 'low',
      votes: 2,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }),
    createIdea({
      id: 2,
      priorityLevel: 'high',
      votes: 8,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    }),
    createIdea({
      id: 3,
      priorityLevel: 'high',
      status: 'completed',
      votes: 20,
      createdAt: new Date('2026-03-01T00:00:00Z'),
    }),
  ];

  it('keeps completed ideas after open ideas for every sort mode', () => {
    expect(sortIdeas(ideas, 'newest').map((idea) => idea.id)).toEqual([2, 1, 3]);
    expect(sortIdeas(ideas, 'priority').map((idea) => idea.id)).toEqual([2, 1, 3]);
    expect(sortIdeas(ideas, 'votes').map((idea) => idea.id)).toEqual([2, 1, 3]);
  });

  it('does not mutate the source array', () => {
    const originalIds = ideas.map((idea) => idea.id);
    sortIdeas(ideas, 'votes');
    expect(ideas.map((idea) => idea.id)).toEqual(originalIds);
  });
});
