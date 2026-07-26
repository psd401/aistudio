import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { knowledgeRepositories } from "./knowledge-repositories";
import { repositoryAccess } from "./repository-access";

export const NEXUS_PROJECT_MEMBER_ROLES = [
  "owner",
  "editor",
  "viewer",
] as const;
export type NexusProjectMemberRole =
  (typeof NEXUS_PROJECT_MEMBER_ROLES)[number];

export const nexusProjects = pgTable(
  "nexus_projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: integer("owner_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    instructions: text("instructions").notNull().default(""),
    projectRepositoryId: integer("project_repository_id")
      .references(() => knowledgeRepositories.id, { onDelete: "restrict" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_nexus_projects_repository").on(table.projectRepositoryId),
    index("idx_nexus_projects_owner_updated").on(table.ownerId, table.updatedAt),
  ]
);

export const nexusProjectMembers = pgTable(
  "nexus_project_members",
  {
    projectId: uuid("project_id")
      .references(() => nexusProjects.id, { onDelete: "cascade" })
      .notNull(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: varchar("role", { length: 16 })
      .$type<NexusProjectMemberRole>()
      .notNull()
      .default("viewer"),
    repositoryAccessId: integer("repository_access_id").references(
      () => repositoryAccess.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    uniqueIndex("uq_nexus_project_owner_member")
      .on(table.projectId)
      .where(sql`${table.role} = 'owner'`),
    index("idx_nexus_project_members_user").on(table.userId, table.projectId),
  ]
);

export const nexusProjectRepositories = pgTable(
  "nexus_project_repositories",
  {
    projectId: uuid("project_id")
      .references(() => nexusProjects.id, { onDelete: "cascade" })
      .notNull(),
    repositoryId: integer("repository_id")
      .references(() => knowledgeRepositories.id, { onDelete: "cascade" })
      .notNull(),
    connectedBy: integer("connected_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.repositoryId] }),
    index("idx_nexus_project_repositories_repository").on(
      table.repositoryId,
      table.projectId
    ),
  ]
);

export type NexusProject = typeof nexusProjects.$inferSelect;
export type NexusProjectMember = typeof nexusProjectMembers.$inferSelect;
