import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const webPanelsTable = pgTable("web_panels", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  imageFileId: text("image_file_id").notNull(),
  price: integer("price").notNull().default(0),
  instructions: text("instructions").notNull(),
  url: text("url"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertWebPanelSchema = createInsertSchema(webPanelsTable).omit({ id: true, addedAt: true });
export type InsertWebPanel = z.infer<typeof insertWebPanelSchema>;
export type WebPanel = typeof webPanelsTable.$inferSelect;