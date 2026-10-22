import { createSupabaseContext } from "npm:@supabase/server@1.9.2";

import {
  corsHeaders,
  createRateLimitFingerprint,
  extractTranscript,
  getRateLimitIdentity,
  isOriginAllowed,
  MAX_MULTIPART_BYTES,
  parseAllowedOrigins,
  parseBoundedInteger,
  validateAudioFile,
} from "./core.ts";

interface RuntimeConfig {
  openAiApiKey: string;
  transcriptionModel: string;
  openAiTimeoutMs: number;
  supabaseUrl: string;
  secretKey: string;
  rateLimitSalt: string;
  rateLimitMaxRequests: number;
  allowedOrigins: Set<string>;
  allowLocalhostOrigins: boolean;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredDefaultKey(name: string): string {
  let keys: unknown;
  try {
    keys = JSON.parse(requiredEnv(name));
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    throw new Error(`${name} must be a JSON object`);
  }
  const value = (keys as Record<string, unknown>).default;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must contain a non-empty default key`);
  }
  return value.trim();
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("boolean environment values must be true or false");
}

function loadConfig(): RuntimeConfig {
  const transcriptionModel = Deno.env.get("OPENAI_TRANSCRIPTION_MODEL")?.trim() || "gpt-transcribe";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(transcriptionModel)) {
    throw new Error("OPENAI_TRANSCRIPTION_MODEL has an invalid format");
  }

  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const parsedSupabaseUrl = new URL(supabaseUrl);
  if (!/^https?:$/.test(parsedSupabaseUrl.protocol) || parsedSupabaseUrl.origin !== supabaseUrl) {
    throw new Error("SUPABASE_URL must be an HTTP(S) origin");
  }

  const rateLimitSalt = requiredEnv("RATE_LIMIT_SALT");
  if (rateLimitSalt.length < 32) {
    throw new Error("RATE_LIMIT_SALT must contain at least 32 characters");
  }

  return {
    openAiApiKey: requiredEnv("OPENAI_API_KEY"),
    transcriptionModel,
    openAiTimeoutMs: parseBoundedInteger(
      Deno.env.get("OPENAI_TRANSCRIPTION_TIMEOUT_MS"),
      45_000,
      5_000,
      60_000,
    ),
    supabaseUrl,
    secretKey: requiredDefaultKey("SUPABASE_SECRET_KEYS"),
    rateLimitSalt,
    rateLimitMaxRequests: parseBoundedInteger(
      Deno.env.get("TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS"),
      30,
      1,
      120,
    ),
    allowedOrigins: parseAllowedOrigins(Deno.env.get("ALLOWED_ORIGINS")),
    allowLocalhostOrigins: parseBoolean(Deno.env.get("ALLOW_LOCALHOST_ORIGINS"), false),
  };
}

function responseHeaders(origin: string | null, requestId: string): HeadersInit {
  return {
    ...corsHeaders(origin),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
  };
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  origin: string | null,
  requestId: string,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders(origin, requestId), ...extraHeaders },
  });
}

async function readBoundedBytes(request: Request): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_MULTIPART_BYTES) {
      throw new RangeError("request body is too large");
    }
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MULTIPART_BYTES) {
      await reader.cancel();
      throw new RangeError("request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function consumeRateLimit(
  config: RuntimeConfig,
  fingerprint: string,
): Promise<RateLimitResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/rpc/consume_generate_action_rate_limit`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": config.secretKey,
        },
        body: JSON.stringify({
          p_fingerprint: fingerprint,
          p_limit: config.rateLimitMaxRequests,
          p_window_seconds: 3_600,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`rate limit RPC returned ${response.status}`);
    const payload: unknown = await response.json();
    const row = Array.isArray(payload) ? payload[0] : undefined;
    if (
      typeof row !== "object" || row === null || typeof row.allowed !== "boolean" ||
      typeof row.remaining !== "number" || typeof row.reset_at !== "string"
    ) {
      throw new Error("rate limit RPC returned an invalid payload");
    }
    return { allowed: row.allowed, remaining: row.remaining, resetAt: row.reset_at };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAi(config: RuntimeConfig, audio: File): Promise<string> {
  const form = new FormData();
  form.append("file", audio, audio.name || "aftertalk-note.webm");
  form.append("model", config.transcriptionModel);
  form.append("response_format", "json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.openAiTimeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${config.openAiApiKey}` },
      body: form,
      signal: controller.signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`OpenAI returned non-JSON with status ${response.status}`);
    }
    if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);
    const transcript = extractTranscript(payload);
    if (!transcript.ok) throw new Error(transcript.error);
    return transcript.value;
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = crypto.randomUUID();
  const origin = request.headers.get("origin");

  let config: RuntimeConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error("transcribe-note configuration error", {
      requestId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return jsonResponse(503, { error: "service is not configured", requestId }, null, requestId);
  }

  if (!isOriginAllowed(origin, config.allowedOrigins, config.allowLocalhostOrigins)) {
    return jsonResponse(403, { error: "origin is not allowed", requestId }, null, requestId);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(origin, requestId) });
  }

  const { error: authenticationError } = await createSupabaseContext(request, {
    auth: "publishable",
  });
  if (authenticationError) {
    return jsonResponse(
      authenticationError.status,
      { error: "unauthorized", requestId },
      origin,
      requestId,
    );
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed", requestId }, origin, requestId, {
      "Allow": "POST, OPTIONS",
    });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data; boundary=")) {
    return jsonResponse(
      415,
      { error: "content-type must be multipart/form-data", requestId },
      origin,
      requestId,
    );
  }

  let rateLimit: RateLimitResult;
  try {
    const identity = getRateLimitIdentity(request.headers);
    if (identity === null) throw new Error("rate limit identity is unavailable");
    const fingerprint = await createRateLimitFingerprint(
      `transcribe:${identity}`,
      config.rateLimitSalt,
    );
    rateLimit = await consumeRateLimit(config, fingerprint);
  } catch (error) {
    console.error("transcribe-note rate limiter unavailable", {
      requestId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return jsonResponse(503, { error: "rate limiter unavailable", requestId }, origin, requestId);
  }

  const rateHeaders = {
    "RateLimit-Limit": String(config.rateLimitMaxRequests),
    "RateLimit-Remaining": String(Math.max(0, rateLimit.remaining)),
    "RateLimit-Reset": rateLimit.resetAt,
  };
  if (!rateLimit.allowed) {
    return jsonResponse(
      429,
      { error: "rate limit exceeded", requestId },
      origin,
      requestId,
      rateHeaders,
    );
  }

  let form: FormData;
  try {
    const bytes = await readBoundedBytes(request);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400;
    return jsonResponse(
      status,
      { error: "invalid multipart body", requestId },
      origin,
      requestId,
      rateHeaders,
    );
  }

  const audio = validateAudioFile(form.get("audio"));
  if (!audio.ok) {
    return jsonResponse(400, { error: audio.error, requestId }, origin, requestId, rateHeaders);
  }

  try {
    const text = await callOpenAi(config, audio.value);
    return jsonResponse(
      200,
      { text, provider: "openai", model: config.transcriptionModel, requestId },
      origin,
      requestId,
      rateHeaders,
    );
  } catch (error) {
    console.error("transcribe-note provider failure", {
      requestId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return jsonResponse(
      502,
      { error: "transcription provider failed", requestId },
      origin,
      requestId,
      rateHeaders,
    );
  }
});
