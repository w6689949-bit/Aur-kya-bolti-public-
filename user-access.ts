import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { accessKeysTable } from "./access-keys";

export const userAccessTable = pgTable("user_access", {
  chatId: text("chat_id").primaryKey(),
  keyId: integer("key_id").references(() => accessKeysTable.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUserAccessSchema = createInsertSchema(userAccessTable).omit({ createdAt: true });
export type InsertUserAccess = z.infer<typeof insertUserAccessSchema>;
export type UserAccess = typeof userAccessTable.$inferSelect;
