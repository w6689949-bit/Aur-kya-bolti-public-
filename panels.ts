import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const panelsTable = pgTable("panels", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  apiKey: text("api_key").notNull().unique(),
  firebaseUrl: text("firebase_url"),
  apkFilename: text("apk_filename"),
  apkOriginalName: text("apk_original_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPanelSchema = createInsertSchema(panelsTable).omit({ id: true, createdAt: true });
export type InsertPanel = z.infer<typeof insertPanelSchema>;
export type Panel = typeof panelsTable.$inferSelect;
