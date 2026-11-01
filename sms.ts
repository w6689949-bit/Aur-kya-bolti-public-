import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, devicesTable, panelsTable, messagesTable } from "@workspace/db";
import { notifyNewSMS } from "../bot/index.js";

const router: IRouter = Router();

router.post("/sms/new", async (req, res): Promise<void> => {
  const { deviceId, from, body, sim, timestamp: msgTimestamp, apiKey } = req.body;
  if (!deviceId || !apiKey) {
    res.status(400).json({ success: false, error: "deviceId and apiKey required" });
    return;
  }
  const [panel] = await db.select().from(panelsTable).where(eq(panelsTable.apiKey, apiKey));
  if (!panel) { res.status(401).json({ success: false, error: "Invalid API key" }); return; }

  const [device] = await db.select().from(devicesTable).where(eq(devicesTable.deviceId, deviceId));
  if (!device) { res.status(404).json({ success: false, error: "Device not found" }); return; }

  const receivedAt = msgTimestamp ? new Date(msgTimestamp) : new Date();
  const [message] = await db
    .insert(messagesTable)
    .values({ deviceId: device.id, fromNumber: from ?? null, body: body ?? null, receivedAt })
    .returning();

  // Fire-and-forget for ~0.2s OTP delivery
  void notifyNewSMS({
    device,
    from: from ?? "Unknown",
    body: body ?? "",
    sim: sim ?? device.phoneNumber ?? deviceId,
    timestamp: receivedAt,
    messageId: message.id,
  });

  res.json({ success: true, messageId: message.id });
});

export default router;
