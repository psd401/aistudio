# Drizzle Relational Queries Guide

Guide for using Drizzle ORM's relational query API to perform eager loading and avoid N+1 query patterns.

**Part of:** Epic #526 - RDS Data API to Drizzle ORM Migration
**Issue:** #542 - Implement Drizzle relations for eager loading

## Overview

Drizzle ORM provides a relational query API that enables type-safe eager loading of related data. This eliminates N+1 query problems by fetching all necessary data in a single database round-trip.

## Key Concepts

### N+1 Query Problem

**Bad Pattern (N+1 Queries):**
```typescript
// ❌ This executes 1 + N queries (1 for users, N for each user's roles)
const users = await executeQuery(
  (db) => db.select().from(schema.users),
  "getUsers"
);

// N additional queries
for (const user of users) {
  const roles = await executeQuery(
    (db) => db.select()
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, user.id)),
    "getUserRoles"
  );
}
```

**Good Pattern (Single Query with Eager Loading):**
```typescript
// ✅ This executes 1 query total, fetching all related data
const usersWithRoles = await executeQuery(
  (db) => db.query.users.findMany({
    with: {
      userRoles: {
        with: {
          role: true,
        },
      },
    },
  }),
  "getUsersWithRoles"
);
```

## Core Relations

### Users → UserRoles → Roles

**Schema Definition** (`/lib/db/schema/relations.ts:93-123`):
```typescript
export const usersRelations = relations(users, ({ one, many }) => ({
  userRoles: many(userRoles),
  // ... other relations
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, {
    fields: [userRoles.userId],
    references: [users.id],
  }),
  role: one(roles, {
    fields: [userRoles.roleId],
    references: [roles.id],
  }),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  userRoles: many(userRoles),
  roleTools: many(roleTools),
  // ... other relations
}));
```

**Query Examples:**

```typescript
import { executeQuery } from "@/lib/db/drizzle-client";
import * as schema from "@/lib/db/schema";

// Get user with all roles (2-level deep)
const user = await executeQuery(
  (db) => db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    with: {
      userRoles: {
        with: {
          role: true,
        },
      },
    },
  }),
  "getUserWithRoles"
);

// Access related data with full type safety
user?.userRoles.forEach((ur) => {
  console.log(ur.role.name); // TypeScript knows the shape
});

// Get all users with roles and tools (3-level deep)
const usersWithRolesAndTools = await executeQuery(
  (db) => db.query.users.findMany({
    with: {
      userRoles: {
        with: {
          role: {
            with: {
              roleTools: {
                with: {
                  tool: true,
                },
              },
            },
          },
        },
      },
    },
  }),
  "getUsersWithRolesAndTools"
);

// Selective field loading (reduce payload size)
const usersSummary = await executeQuery(
  (db) => db.query.users.findMany({
    columns: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
    },
    with: {
      userRoles: {
        columns: {
          id: true,
        },
        with: {
          role: {
            columns: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  }),
  "getUsersSummary"
);
```

### Conversations → Messages

**Schema Definition** (`/lib/db/schema/relations.ts:226-274`):
```typescript
export const nexusConversationsRelations = relations(
  nexusConversations,
  ({ one, many }) => ({
    user: one(users, {
      fields: [nexusConversations.userId],
      references: [users.id],
    }),
    folder: one(nexusFolders, {
      fields: [nexusConversations.folderId],
      references: [nexusFolders.id],
    }),
    messages: many(nexusMessages),
    events: many(nexusConversationEvents),
    // ... other relations
  })
);

export const nexusMessagesRelations = relations(nexusMessages, ({ one }) => ({
  conversation: one(nexusConversations, {
    fields: [nexusMessages.conversationId],
    references: [nexusConversations.id],
  }),
  model: one(aiModels, {
    fields: [nexusMessages.modelId],
    references: [aiModels.id],
  }),
}));
```

**Query Examples:**

```typescript
// Get conversation with all messages and AI model details
const conversation = await executeQuery(
  (db) => db.query.nexusConversations.findFirst({
    where: eq(schema.nexusConversations.id, conversationId),
    with: {
      messages: {
        with: {
          model: true,
        },
        orderBy: (messages, { asc }) => [asc(messages.createdAt)],
      },
      user: {
        columns: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      folder: true,
    },
  }),
  "getConversationWithMessages"
);

// Get user's conversations with message counts (aggregation pattern)
const conversations = await executeQuery(
  (db) => db.query.nexusConversations.findMany({
    where: eq(schema.nexusConversations.userId, userId),
    with: {
      messages: {
        columns: {
          id: true,
        },
        limit: 1, // Just to check if any messages exist
      },
      folder: {
        columns: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
    orderBy: (conversations, { desc }) => [desc(conversations.updatedAt)],
  }),
  "getUserConversations"
);

// Get latest message per conversation (subquery pattern)
const conversationsWithLatestMessage = await executeQuery(
  (db) => db.query.nexusConversations.findMany({
    where: eq(schema.nexusConversations.userId, userId),
    with: {
      messages: {
        limit: 1,
        orderBy: (messages, { desc }) => [desc(messages.createdAt)],
        with: {
          model: {
            columns: {
              id: true,
              modelId: true,
              displayName: true,
            },
          },
        },
      },
    },
  }),
  "getConversationsWithLatestMessage"
);
```

### AI Models → Chain Prompts

**Schema Definition** (`/lib/db/schema/relations.ts:158-168, 572-584`):
```typescript
export const chainPromptsRelations = relations(chainPrompts, ({ one, many }) => ({
  assistantArchitect: one(assistantArchitects, {
    fields: [chainPrompts.assistantArchitectId],
    references: [assistantArchitects.id],
  }),
  model: one(aiModels, {
    fields: [chainPrompts.modelId],
    references: [aiModels.id],
  }),
  promptResults: many(promptResults),
}));

export const aiModelsRelations = relations(aiModels, ({ many }) => ({
  chainPrompts: many(chainPrompts),
  nexusMessages: many(nexusMessages),
  aiStreamingJobs: many(aiStreamingJobs),
  // ... other relations
}));
```

**Query Examples:**

```typescript
// Get AI model with all chain prompts
const model = await executeQuery(
  (db) => db.query.aiModels.findFirst({
    where: eq(schema.aiModels.id, modelId),
    with: {
      chainPrompts: {
        with: {
          assistantArchitect: {
            columns: {
              id: true,
              name: true,
              description: true,
            },
          },
          promptResults: {
            limit: 5,
            orderBy: (results, { desc }) => [desc(results.createdAt)],
          },
        },
      },
    },
  }),
  "getModelWithChainPrompts"
);

// Get assistant architect with all prompts and models
const architect = await executeQuery(
  (db) => db.query.assistantArchitects.findFirst({
    where: eq(schema.assistantArchitects.id, architectId),
    with: {
      chainPrompts: {
        with: {
          model: {
            columns: {
              id: true,
              modelId: true,
              displayName: true,
              provider: true,
            },
          },
        },
        orderBy: (prompts, { asc }) => [asc(prompts.order)],
      },
      user: {
        columns: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  }),
  "getAssistantArchitectWithPrompts"
);
```

## Additional Relations

### Ideas → Votes → Notes

**Query Examples:**

```typescript
// Get idea with all votes and notes
const idea = await executeQuery(
  (db) => db.query.ideas.findFirst({
    where: eq(schema.ideas.id, ideaId),
    with: {
      user: {
        columns: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      votes: {
        with: {
          user: {
            columns: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
      notes: {
        with: {
          user: {
            columns: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: (notes, { desc }) => [desc(notes.createdAt)],
      },
    },
  }),
  "getIdeaWithVotesAndNotes"
);

// Get all ideas with vote counts (optimized)
const ideas = await executeQuery(
  (db) => db.query.ideas.findMany({
    with: {
      user: {
        columns: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      votes: {
        columns: {
          id: true,
        },
      },
    },
    orderBy: (ideas, { desc }) => [desc(ideas.votes)],
  }),
  "getIdeasWithVotes"
);
```

### Navigation → Hierarchy → Roles

**Query Examples:**

```typescript
// Get navigation with hierarchy and access control
const navigation = await executeQuery(
  (db) => db.query.navigationItems.findMany({
    where: eq(schema.navigationItems.isActive, true),
    with: {
      tool: {
        columns: {
          id: true,
          name: true,
          description: true,
        },
      },
      children: {
        with: {
          roles: true,
        },
      },
      roles: true,
    },
    orderBy: (items, { asc }) => [asc(items.position)],
  }),
  "getNavigationHierarchy"
);

// Get navigation tree (recursive pattern)
const navigationTree = await executeQuery(
  (db) => db.query.navigationItems.findMany({
    where: and(
      eq(schema.navigationItems.isActive, true),
      isNull(schema.navigationItems.parentId) // Root items only
    ),
    with: {
      children: {
        with: {
          children: true, // 3-level deep
          roles: true,
        },
      },
      roles: true,
    },
    orderBy: (items, { asc }) => [asc(items.position)],
  }),
  "getNavigationTree"
);
```

### Model Comparisons

**Query Examples:**

```typescript
// Get comparison with both models and user
const comparison = await executeQuery(
  (db) => db.query.modelComparisons.findFirst({
    where: eq(schema.modelComparisons.id, comparisonId),
    with: {
      user: {
        columns: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      model1: {
        columns: {
          id: true,
          modelId: true,
          displayName: true,
          provider: true,
        },
      },
      model2: {
        columns: {
          id: true,
          modelId: true,
          displayName: true,
          provider: true,
        },
      },
    },
  }),
  "getComparisonWithModels"
);
```

## Performance Best Practices

### 1. Select Only Needed Columns

```typescript
// ❌ Fetches all columns (wasteful)
const users = await executeQuery(
  (db) => db.query.users.findMany({
    with: { userRoles: true },
  }),
  "getUsers"
);

// ✅ Fetches only needed columns
const users = await executeQuery(
  (db) => db.query.users.findMany({
    columns: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
    },
    with: {
      userRoles: {
        columns: {
          id: true,
        },
        with: {
          role: {
            columns: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  }),
  "getUsers"
);
```

### 2. Limit Related Records

```typescript
// Limit nested collections to avoid massive payloads
const conversations = await executeQuery(
  (db) => db.query.nexusConversations.findMany({
    with: {
      messages: {
        limit: 50, // Only latest 50 messages
        orderBy: (messages, { desc }) => [desc(messages.createdAt)],
      },
    },
    limit: 20, // Only latest 20 conversations
  }),
  "getRecentConversations"
);
```

### 3. Use Filters on Relations

```typescript
// Filter related records
const user = await executeQuery(
  (db) => db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    with: {
      nexusConversations: {
        where: (conversations, { eq }) => eq(conversations.isArchived, false),
        orderBy: (conversations, { desc }) => [desc(conversations.updatedAt)],
        limit: 10,
      },
    },
  }),
  "getUserWithActiveConversations"
);
```

### 4. Avoid Deep Nesting

```typescript
// ❌ Too deep (4+ levels can be slow)
const deepQuery = await executeQuery(
  (db) => db.query.users.findMany({
    with: {
      userRoles: {
        with: {
          role: {
            with: {
              roleTools: {
                with: {
                  tool: true,
                },
              },
            },
          },
        },
      },
    },
  }),
  "deepQuery"
);

// ✅ Better: Query in two parts if needed
const users = await executeQuery(
  (db) => db.query.users.findMany({
    with: {
      userRoles: {
        with: {
          role: true,
        },
      },
    },
  }),
  "getUsers"
);

// Then query tools separately if needed
const roleIds = users.flatMap(u => u.userRoles.map(ur => ur.roleId));
const roleTools = await executeQuery(
  (db) => db.query.roleTools.findMany({
    where: inArray(schema.roleTools.roleId, roleIds),
    with: {
      tool: true,
    },
  }),
  "getRoleTools"
);
```

## Migration from Legacy Queries

### Before (Multiple Queries)

```typescript
// Legacy RDS Data API approach
const userResult = await executeSQL(
  "SELECT * FROM users WHERE id = $1",
  [userId]
);

const rolesResult = await executeSQL(
  `SELECT r.* FROM roles r
   JOIN user_roles ur ON r.id = ur.role_id
   WHERE ur.user_id = $1`,
  [userId]
);

const toolsResult = await executeSQL(
  `SELECT t.* FROM tools t
   JOIN role_tools rt ON t.id = rt.tool_id
   JOIN user_roles ur ON rt.role_id = ur.role_id
   WHERE ur.user_id = $1`,
  [userId]
);
```

### After (Single Query)

```typescript
// Drizzle relational query
const user = await executeQuery(
  (db) => db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    with: {
      userRoles: {
        with: {
          role: {
            with: {
              roleTools: {
                with: {
                  tool: true,
                },
              },
            },
          },
        },
      },
    },
  }),
  "getUserWithRolesAndTools"
);
```

## Type Safety Benefits

Drizzle's relational queries provide full TypeScript inference:

```typescript
const conversation = await executeQuery(
  (db) => db.query.nexusConversations.findFirst({
    where: eq(schema.nexusConversations.id, conversationId),
    with: {
      messages: {
        with: {
          model: true,
        },
      },
      user: true,
    },
  }),
  "getConversation"
);

// TypeScript knows the exact shape
conversation?.messages.forEach((message) => {
  // ✅ All properties are typed
  console.log(message.content);
  console.log(message.model.displayName);
  console.log(message.model.provider);
});

// ❌ TypeScript error: Property doesn't exist
console.log(conversation?.folder); // Error if not included in 'with'
```

## References

- [Drizzle Relations Documentation](https://orm.drizzle.team/docs/relations)
- [Drizzle Relational Queries](https://orm.drizzle.team/docs/rqb)
- Epic #526: RDS Data API to Drizzle ORM Migration
- Issue #542: Implement Drizzle relations for eager loading
- `/lib/db/schema/relations.ts`: Full relation definitions
- `/lib/db/drizzle-client.ts`: Query execution utilities

## Summary

**Key Takeaways:**
- Use `db.query` API with `with` clause for eager loading
- Avoid N+1 patterns by fetching related data upfront
- Select only needed columns to reduce payload size
- Limit nested collections to avoid massive datasets
- Leverage TypeScript inference for type safety
- Keep nesting depth reasonable (2-3 levels max)

**Migration Path:**
1. Identify queries that fetch related data separately
2. Replace with relational queries using `with` clause
3. Test performance improvements
4. Update type definitions to leverage inference
5. Remove legacy query code once validated
