import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { panelsTable } from "./panels";

export const devicesTable = pgTable("devices", {
  id: serial("id").primaryKey(),
  panelId: integer("panel_id").notNull().references(() => panelsTable.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull().unique(),
  phoneNumber: text("phone_number"),
  model: text("model"),
  simNumber: text("sim_number"),
  battery: integer("battery").default(0),
  isOnline: boolean("is_online").notNull().default(false),
  isListed: boolean("is_listed").notNull().default(true),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  approvalStatus: text("approval_status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDeviceSchema = createInsertSchema(devicesTable).omit({ id: true, createdAt: true });
export type InsertDevice = z.infer<typeof insertDeviceSchema>;
export type Device = typeof devicesTable.$inferSelect;
