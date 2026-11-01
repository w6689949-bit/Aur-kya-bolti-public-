import { logger } from "../lib/logger.js";

export async function sendSmsViaFirebase(params: {
  firebaseUrl: string;
  panelName: string;
  firebaseDeviceId: string;
  toNumber: string;
  message: string;
  apiKey?: string;
}): Promise<void> {
  const { firebaseUrl, panelName, firebaseDeviceId, toNumber, message, apiKey } = params;
  const base = firebaseUrl.replace(/\/$/, "");
  const auth = apiKey ? `?auth=${encodeURIComponent(apiKey)}` : "";
  const url = `${base}/${panelName}/Send_Sms/${firebaseDeviceId}.json${auth}`;

  const body = JSON.stringify({
    to: toNumber,
    msg: message,
    number: toNumber,
    body: message,
    date: Date.now().toString(),
    timestamp: Date.now(),
  });

  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error({ url, status: res.status, text }, "Firebase send SMS failed");
    throw new Error(`Firebase write failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }

  logger.info({ panelName, firebaseDeviceId, toNumber }, "SMS command sent to Firebase ✅");
}
