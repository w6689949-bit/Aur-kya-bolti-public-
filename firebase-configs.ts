import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const firebaseConfigsTable = pgTable("firebase_configs", {
  id: serial("id").primaryKey(),
  url: text("url").notNull().unique(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertFirebaseConfigSchema = createInsertSchema(firebaseConfigsTable).omit({ id: true, createdAt: true });
export type InsertFirebaseConfig = z.infer<typeof insertFirebaseConfigSchema>;
export type FirebaseConfig = typeof firebaseConfigsTable.$inferSelect;
