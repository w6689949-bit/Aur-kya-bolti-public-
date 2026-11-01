/**
 * Decodes ZXKAI ?s= XOR-obfuscated share params into { url, key, label }
 * Key discovered from ZXKAI source: "ZXKAIv1_Xk9mP2wN7qL4vR6jH3cF8yT1ZbE5sA09"
 */
const ZXKAI_KEY = "ZXKAIv1_Xk9mP2wN7qL4vR6jH3cF8yT1ZbE5sA09";

export function decodeZxkaiParam(
  encoded: string
): { url: string; key: string; label?: string } | null {
  // Strategy 1: new XOR-obfuscated JSON format (ZXKAI >= v1)
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const bin = Buffer.from(padded, "base64");
    const dec = Buffer.alloc(bin.length);
    for (let i = 0; i < bin.length; i++) {
      dec[i] = bin[i] ^ ZXKAI_KEY.charCodeAt(i % ZXKAI_KEY.length);
    }
    const obj = JSON.parse(dec.toString("utf8")) as { u?: string; k?: string; l?: string };
    if (obj.u && obj.k) {
      return { url: obj.u, key: obj.k, label: obj.l ?? "" };
    }
  } catch {}

  // Strategy 2: legacy plain-btoa format (ZXKAI < v1)
  try {
    const plain = decodeURIComponent(escape(Buffer.from(encoded, "base64").toString("binary")));
    const [url, key] = plain.split("|||");
    if (url?.startsWith("http") && key) return { url, key };
  } catch {}

  // Strategy 3: old single-pipe XOR-42 format
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const bin = Buffer.from(b64, "base64");
    const dec = Buffer.from(bin.map((b) => b ^ 42)).toString("utf8");
    const pipeIdx = dec.indexOf("|");
    if (pipeIdx !== -1) {
      const url = dec.slice(0, pipeIdx).trim();
      const key = dec.slice(pipeIdx + 1).trim();
      if (url.startsWith("http")) return { url, key };
    }
    if (dec.trim().startsWith("http")) return { url: dec.trim(), key: "" };
  } catch {}

  return null;
}
