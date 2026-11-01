const bad = new Set(["yes","no","true","false","null","none","unknown","n/a","na"]);

export function normalizePhoneNumber(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || bad.has(raw.toLowerCase())) return "";
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

export function phoneNumberKey(value: unknown): string {
  return normalizePhoneNumber(value);
}

export function isValidPhoneNumber(value: unknown): boolean {
  return /^\d{5,15}$/.test(normalizePhoneNumber(value));
}
