/**
 * Tool Input Fields Table Schema
 * Form field definitions for assistant architects
 */

import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { fieldTypeEnum } from "../enums";
import { assistantArchitects } from "./assistant-architects";
import type { ToolInputFieldOptions } from "@/types/db-types";

export const toolInputFields = pgTable("tool_input_fields", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  fieldType: fieldTypeEnum("field_type").notNull(),
  options: jsonb("options").$type<ToolInputFieldOptions>(),
  position: integer("position").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  label: text("label").default("").notNull(),
  assistantArchitectId: integer("assistant_architect_id").references(
    () => assistantArchitects.id
  ),
});
