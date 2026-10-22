export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_MULTIPART_BYTES = MAX_AUDIO_BYTES + 256 * 1024;
export const MAX_TRANSCRIPT_CHARS = 6000;

export const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/mp4",
  "audio/m4a",
  "audio/webm",
  "audio/ogg",
  "audio/wav",
]);

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function normalizedAudioType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function validateAudioFile(value: FormDataEntryValue | null): ValidationResult<File> {
  if (!(value instanceof File)) return { ok: false, error: "audio file is required" };
  if (value.size === 0) return { ok: false, error: "audio file is empty" };
  if (value.size > MAX_AUDIO_BYTES) return { ok: false, error: "audio file is too large" };
  if (!SUPPORTED_AUDIO_TYPES.has(normalizedAudioType(value.type))) {
    return { ok: false, error: "audio file type is not supported" };
  }
  return { ok: true, value };
}

export function extractTranscript(payload: unknown): ValidationResult<string> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: "provider response must be an object" };
  }
  const text = (payload as Record<string, unknown>).text;
  if (typeof text !== "string") return { ok: false, error: "provider response is missing text" };
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return { ok: false, error: "provider transcript is empty" };
  if (normalized.length > MAX_TRANSCRIPT_CHARS) {
    return { ok: false, error: "provider transcript is too long" };
  }
  return { ok: true, value: normalized };
}

export function parseBoundedInteger(
  raw: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  if (!/^\d+$/.test(raw.trim())) throw new Error("value must be an integer");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`value must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const candidate of (raw ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    if (candidate === "*") throw new Error("wildcard CORS origins are not permitted");
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error(`invalid allowed origin: ${candidate}`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== candidate) {
      throw new Error(`allowed origin must be an exact HTTP(S) origin: ${candidate}`);
    }
    origins.add(candidate);
  }
  return origins;
}

export function isOriginAllowed(
  origin: string | null,
  allowedOrigins: Set<string>,
  allowLocalhost: boolean,
): boolean {
  if (origin === null) return false;
  if (allowedOrigins.has(origin)) return true;
  if (!allowLocalhost) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) &&
      url.origin === origin;
  } catch {
    return false;
  }
}

export function corsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
  if (origin !== null) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function sanitizeClientIp(value: string | null): string | null {
  if (value === null) return null;
  const first = value.split(",", 1)[0].trim();
  const containsControlCharacter = [...first].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (first.length === 0 || first.length > 128 || containsControlCharacter) return null;
  return first;
}

export function getRateLimitIdentity(headers: Headers): string | null {
  return sanitizeClientIp(
    headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for") ?? headers.get("x-real-ip"),
  );
}

export async function createRateLimitFingerprint(ip: string, salt: string): Promise<string> {
  if (salt.length < 32) throw new Error("RATE_LIMIT_SALT must contain at least 32 characters");
  if (!ip) throw new Error("client IP is required for rate limiting");
  const bytes = new TextEncoder().encode(`${salt}\n${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
