import { integer, pgTable, primaryKey, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { psdAgentSkills } from "./agent-skills";
import { knowledgeRepositories } from "./knowledge-repositories";

export const skillRepositoryBindings = pgTable(
  "skill_repository_bindings",
  {
    skillId: uuid("skill_id")
      .references(() => psdAgentSkills.id, { onDelete: "cascade" })
      .notNull(),
    repositoryId: integer("repository_id")
      .references(() => knowledgeRepositories.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.skillId, table.repositoryId] }),
    index("idx_skill_repository_bindings_repository").on(
      table.repositoryId,
      table.skillId
    ),
  ]
);

export type SkillRepositoryBinding =
  typeof skillRepositoryBindings.$inferSelect;
