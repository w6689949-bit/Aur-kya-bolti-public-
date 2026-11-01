import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botLinksTable = pgTable("bot_links", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  url: text("url").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBotLinkSchema = createInsertSchema(botLinksTable).omit({ id: true, addedAt: true });
export type InsertBotLink = z.infer<typeof insertBotLinkSchema>;
export type BotLink = typeof botLinksTable.$inferSelect;
