import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, devicesTable, panelsTable } from "@workspace/db";
import { notifyDeviceActivity, notifyNumbersChanged } from "../bot/index.js";

const router: IRouter = Router();

async function getPanel(apiKey: string) {
  const [panel] = await db.select().from(panelsTable).where(eq(panelsTable.apiKey, apiKey));
  return panel ?? null;
}

router.post("/device/register", async (req, res): Promise<void> => {
  const { deviceId, phoneNumber, model, simNumber, apiKey, battery } = req.body;
  if (!deviceId || !apiKey) {
    res.status(400).json({ success: false, error: "deviceId and apiKey required" });
    return;
  }
  const panel = await getPanel(apiKey);
  if (!panel) { res.status(401).json({ success: false, error: "Invalid API key" }); return; }
  const [existing] = await db
    .select({ id: devicesTable.id, isOnline: devicesTable.isOnline, phoneNumber: devicesTable.phoneNumber })
    .from(devicesTable)
    .where(eq(devicesTable.deviceId, deviceId))
    .limit(1);
  await db
    .insert(devicesTable)
    .values({
      panelId: panel.id,
      deviceId,
      phoneNumber: phoneNumber ?? null,
      model: model ?? null,
      simNumber: simNumber ?? null,
      battery: typeof battery === "number" ? battery : 0,
      isOnline: true,
      lastSeen: new Date(),
    })
    .onConflictDoUpdate({
      target: devicesTable.deviceId,
      set: {
        phoneNumber: phoneNumber ?? null,
        model: model ?? null,
        simNumber: simNumber ?? null,
        battery: typeof battery === "number" ? battery : 0,
        isOnline: true,
        lastSeen: new Date(),
      },
    });
  const event = !existing
    ? "new"
    : !existing.isOnline
      ? "online"
      : (!existing.phoneNumber && phoneNumber ? "new" : null);
  if (event && existing) void notifyDeviceActivity(event, existing.id);
  if (event && !existing) {
    const [created] = await db.select({ id: devicesTable.id }).from(devicesTable)
      .where(eq(devicesTable.deviceId, deviceId)).limit(1);
    if (created) void notifyDeviceActivity(event, created.id);
  }
  if (event) notifyNumbersChanged();
  res.json({ success: true, message: "Registered successfully" });
});

router.post("/device/heartbeat", async (req, res): Promise<void> => {
  const { deviceId, battery, apiKey } = req.body;
  if (!deviceId || !apiKey) {
    res.status(400).json({ success: false, error: "deviceId and apiKey required" });
    return;
  }
  const panel = await getPanel(apiKey);
  if (!panel) { res.status(401).json({ success: false, error: "Invalid API key" }); return; }
  const [device] = await db.select({ id: devicesTable.id, isOnline: devicesTable.isOnline }).from(devicesTable)
    .where(eq(devicesTable.deviceId, deviceId)).limit(1);
  await db
    .update(devicesTable)
    .set({
      isOnline: true,
      lastSeen: new Date(),
      battery: typeof battery === "number" ? battery : undefined,
    })
    .where(eq(devicesTable.deviceId, deviceId));
  if (device && !device.isOnline) {
    void notifyDeviceActivity("online", device.id);
    notifyNumbersChanged();
  }
  res.json({ success: true });
});

router.post("/device/offline", async (req, res): Promise<void> => {
  const { deviceId, apiKey } = req.body;
  if (!deviceId || !apiKey) {
    res.status(400).json({ success: false, error: "deviceId and apiKey required" });
    return;
  }
  const panel = await getPanel(apiKey);
  if (!panel) { res.status(401).json({ success: false, error: "Invalid API key" }); return; }
  const [device] = await db.select({ id: devicesTable.id, isOnline: devicesTable.isOnline }).from(devicesTable)
    .where(eq(devicesTable.deviceId, deviceId)).limit(1);
  await db
    .update(devicesTable)
    .set({ isOnline: false, lastSeen: new Date() })
    .where(eq(devicesTable.deviceId, deviceId));
  if (device?.isOnline) {
    void notifyDeviceActivity("offline", device.id);
    notifyNumbersChanged();
  }
  res.json({ success: true });
});

export default router;
