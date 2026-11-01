import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const forceChannelsTable = pgTable("force_channels", {
  id: serial("id").primaryKey(),
  channelId: text("channel_id").notNull().unique(),
  channelUsername: text("channel_username"),
  label: text("label"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertForceChannelSchema = createInsertSchema(forceChannelsTable).omit({ id: true, createdAt: true });
export type InsertForceChannel = z.infer<typeof insertForceChannelSchema>;
export type ForceChannel = typeof forceChannelsTable.$inferSelect;
