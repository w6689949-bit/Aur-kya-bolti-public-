import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const apkLinksTable = pgTable("apk_links", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  url: text("url").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertApkLinkSchema = createInsertSchema(apkLinksTable).omit({ id: true, addedAt: true });
export type InsertApkLink = z.infer<typeof insertApkLinkSchema>;
export type ApkLink = typeof apkLinksTable.$inferSelect;
