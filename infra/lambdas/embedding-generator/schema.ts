/**
 * Minimal Drizzle schema for embedding-generator Lambda.
 *
 * Defines only the columns this Lambda reads or writes.
 * Dimension-agnostic vector type — the DB column enforces dimensions at INSERT/UPDATE time.
 */

import { customType, integer, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';

function flexVector(columnName: string) {
  return customType<{ data: number[] | null; driverData: string | null }>({
    dataType() {
      return 'vector';
    },
    toDriver(value: number[] | null): string | null {
      if (value === null) return null;
      return `[${value.join(',')}]`;
    },
    fromDriver(value: string | null): number[] | null {
      if (value === null) return null;
      return JSON.parse(value) as number[];
    },
  })(columnName);
}

export const settings = pgTable('settings', {
  id: serial('id').primaryKey(),
  key: varchar('key', { length: 255 }).notNull(),
  value: text('value'),
  category: varchar('category', { length: 100 }),
});

export const repositoryItems = pgTable('repository_items', {
  id: serial('id').primaryKey(),
  processingStatus: text('processing_status'),
  processingError: text('processing_error'),
  updatedAt: timestamp('updated_at'),
});

export const repositoryItemChunks = pgTable('repository_item_chunks', {
  id: serial('id').primaryKey(),
  // READ-ONLY via Drizzle. Writes use db.execute(sql`...::vector`) because
  // postgres.js does not coerce parameterised text values to the vector column
  // type automatically — the explicit ::vector cast is required.
  embedding: flexVector('embedding'),
});
