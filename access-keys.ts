import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const accessKeysTable = pgTable("access_keys", {
  id: serial("id").primaryKey(),
  keyCode: text("key_code").notNull().unique(),
  durationHours: integer("duration_hours").notNull(),
  price: integer("price").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimedByChatId: text("claimed_by_chat_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAccessKeySchema = createInsertSchema(accessKeysTable).omit({ id: true, createdAt: true });
export type InsertAccessKey = z.infer<typeof insertAccessKeySchema>;
export type AccessKey = typeof accessKeysTable.$inferSelect;
