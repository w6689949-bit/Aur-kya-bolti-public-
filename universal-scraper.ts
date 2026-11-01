import { decodeZxkaiParam } from "./decode-url.js";
import { logger } from "../lib/logger.js";

async function fetchText(url: string, timeout = 10000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function validateFirebase(url: string, apiKey?: string): Promise<boolean> {
  try {
    const base = url.replace(/\/$/, "");
    const auth = apiKey ? `?auth=${encodeURIComponent(apiKey)}` : "";
    const res = await fetch(`${base}/clients.json${auth}`, { signal: AbortSignal.timeout(6000) });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export async function findWorkingFirebaseCreds(
  websiteUrl: string
): Promise<Array<{ url: string; key: string }>> {
  const results: Array<{ url: string; key: string }> = [];

  // Strategy 1: ZXKAI ?s= encoded param
  try {
    const parsed = new URL(websiteUrl);
    const sParam = parsed.searchParams.get("s");
    if (sParam) {
      const decoded = decodeZxkaiParam(sParam);
      if (decoded) {
        const valid = await validateFirebase(decoded.url, decoded.key || undefined);
        if (valid) {
          results.push(decoded);
          return results;
        }
      }
    }
    // Strategy 2: raw querystring params
    const rawUrl = parsed.searchParams.get("url") ?? parsed.searchParams.get("firebase");
    const rawKey = parsed.searchParams.get("key") ?? parsed.searchParams.get("auth") ?? "";
    if (rawUrl) {
      const valid = await validateFirebase(rawUrl, rawKey || undefined);
      if (valid) { results.push({ url: rawUrl, key: rawKey }); return results; }
    }
  } catch (e) { logger.debug({ e }, "URL parse failed"); }

  // Strategy 3: Scan HTML for firebaseio.com URLs
  try {
    const html = await fetchText(websiteUrl);
    const firebaseRegex = /https:\/\/[a-z0-9-]+\.firebaseio\.com/g;
    const found = [...new Set(html.match(firebaseRegex) ?? [])];
    for (const fbUrl of found) {
      const keyMatch = html.match(/['"]([\w-]{20,})['"]/);
      const key = keyMatch?.[1] ?? "";
      const valid = await validateFirebase(fbUrl, key || undefined);
      if (valid) { results.push({ url: fbUrl, key }); }
    }
    if (results.length) return results;

    // Strategy 4: Scan linked JS bundles
    const scriptRegex = /src="([^"]*\.js[^"]*)"/g;
    let m: RegExpExecArray | null;
    const baseUrl = new URL(websiteUrl);
    while ((m = scriptRegex.exec(html)) !== null) {
      try {
        const jsUrl = new URL(m[1], baseUrl).href;
        const js = await fetchText(jsUrl, 8000);
        const fbMatches = [...new Set(js.match(firebaseRegex) ?? [])];
        for (const fbUrl of fbMatches) {
          const keyMatch = js.match(/['"](AIza[\w-]{35,})['"]/);
          const key = keyMatch?.[1] ?? "";
          const valid = await validateFirebase(fbUrl, key || undefined);
          if (valid) { results.push({ url: fbUrl, key }); }
        }
        if (results.length) return results;
      } catch { continue; }
    }
  } catch (e) { logger.error({ e, websiteUrl }, "Scraper failed"); }

  return results;
}
