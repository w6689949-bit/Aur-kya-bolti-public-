import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const keyPlansTable = pgTable("key_plans", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  durationHours: integer("duration_hours").notNull(),
  price: integer("price").notNull(), // rupees
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertKeyPlanSchema = createInsertSchema(keyPlansTable).omit({ id: true, createdAt: true });
export type InsertKeyPlan = z.infer<typeof insertKeyPlanSchema>;
export type KeyPlan = typeof keyPlansTable.$inferSelect;
