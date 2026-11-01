import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const paymentRequestsTable = pgTable("payment_requests", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  amount: integer("amount").notNull(), // rupees
  utrNumber: text("utr_number").notNull(),
  screenshotFileId: text("screenshot_file_id"),
  requestType: text("request_type").notNull().default("wallet"), // wallet | web_panel
  webPanelId: integer("web_panel_id"),
  webPanelUrl: text("web_panel_url"),
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  adminNote: text("admin_note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPaymentRequestSchema = createInsertSchema(paymentRequestsTable).omit({
  id: true,
  createdAt: true,
  status: true,
  reviewedAt: true,
  adminNote: true,
});
export type InsertPaymentRequest = z.infer<typeof insertPaymentRequestSchema>;
export type PaymentRequest = typeof paymentRequestsTable.$inferSelect;
