import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const qrItemsTable = pgTable("qr_items", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  data: text("data").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertQrItemSchema = createInsertSchema(qrItemsTable).omit({ id: true, addedAt: true });
export type InsertQrItem = z.infer<typeof insertQrItemSchema>;
export type QrItem = typeof qrItemsTable.$inferSelect;
