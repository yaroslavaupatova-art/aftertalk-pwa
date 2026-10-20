import { createSupabaseContext } from "npm:@supabase/server@1.9.2";

import {
  ACTION_CARD_JSON_SCHEMA,
  buildGenerationPrompt,
  corsHeaders,
  createRateLimitFingerprint,
  extractResponseOutput,
  getRateLimitIdentity,
  isOriginAllowed,
  MAX_REQUEST_BYTES,
  parseAllowedOrigins,
  parseBoundedInteger,
  validateActionCard,
  validateGenerateActionInput,
} from "./core.ts";

interface RuntimeConfig {
  openAiApiKey: string;
  openAiModel: string;
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
  const openAiModel = Deno.env.get("OPENAI_MODEL")?.trim() || "gpt-6-luna";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(openAiModel)) {
    throw new Error("OPENAI_MODEL has an invalid format");
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
    openAiModel,
    openAiTimeoutMs: parseBoundedInteger(Deno.env.get("OPENAI_TIMEOUT_MS"), 30_000, 5_000, 60_000),
    supabaseUrl,
    secretKey: requiredDefaultKey("SUPABASE_SECRET_KEYS"),
    rateLimitSalt,
    rateLimitMaxRequests: parseBoundedInteger(
      Deno.env.get("RATE_LIMIT_MAX_REQUESTS"),
      30,
      1,
      300,
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

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_REQUEST_BYTES) {
      throw new RangeError("request body is too large");
    }
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

function sanitizedProviderMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const usage = typeof payload.usage === "object" && payload.usage !== null
    ? payload.usage as Record<string, unknown>
    : {};
  const integerOrUndefined = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

  return {
    provider: "openai",
    responseId: typeof payload.id === "string" ? payload.id.slice(0, 200) : undefined,
    model: typeof payload.model === "string" ? payload.model.slice(0, 100) : undefined,
    status: typeof payload.status === "string" ? payload.status.slice(0, 50) : undefined,
    usage: {
      inputTokens: integerOrUndefined(usage.input_tokens),
      outputTokens: integerOrUndefined(usage.output_tokens),
      totalTokens: integerOrUndefined(usage.total_tokens),
    },
  };
}

async function callOpenAi(
  config: RuntimeConfig,
  prompt: string,
): Promise<{ action: unknown; metadata: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.openAiTimeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openAiModel,
        instructions:
          "You generate a single grounded AfterTalk Action Card. Follow the user prompt's fact/suggestion separation and return only the required strict JSON object.",
        input: prompt,
        max_output_tokens: 2_500,
        text: {
          format: {
            type: "json_schema",
            name: "aftertalk_action_card",
            strict: true,
            schema: ACTION_CARD_JSON_SCHEMA,
          },
        },
      }),
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`OpenAI returned non-JSON with status ${response.status}`);
    }
    if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("OpenAI returned an invalid payload");
    }

    const extracted = extractResponseOutput(payload);
    if (!extracted.ok) throw new Error(`OpenAI output ${extracted.kind}: ${extracted.message}`);

    let action: unknown;
    try {
      action = JSON.parse(extracted.text);
    } catch {
      throw new Error("OpenAI output was not valid JSON");
    }
    return { action, metadata: sanitizedProviderMetadata(payload as Record<string, unknown>) };
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
    console.error("generate-action configuration error", {
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
    return jsonResponse(
      405,
      { error: "method not allowed", requestId },
      origin,
      requestId,
      { "Allow": "POST, OPTIONS" },
    );
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.split(";", 1)[0].trim() !== "application/json") {
    return jsonResponse(
      415,
      { error: "content-type must be application/json", requestId },
      origin,
      requestId,
    );
  }

  let rawBody: string;
  try {
    rawBody = await readBoundedBody(request);
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400;
    return jsonResponse(status, { error: "invalid request body", requestId }, origin, requestId);
  }

  let inputJson: unknown;
  try {
    inputJson = JSON.parse(rawBody);
  } catch {
    return jsonResponse(
      400,
      { error: "request body must be valid JSON", requestId },
      origin,
      requestId,
    );
  }
  const validatedInput = validateGenerateActionInput(inputJson);
  if (!validatedInput.ok) {
    return jsonResponse(400, { error: validatedInput.error, requestId }, origin, requestId);
  }

  let rateLimit: RateLimitResult;
  try {
    const identity = getRateLimitIdentity(request.headers);
    if (identity === null) throw new Error("rate limit identity is unavailable");
    const fingerprint = await createRateLimitFingerprint(identity, config.rateLimitSalt);
    rateLimit = await consumeRateLimit(config, fingerprint);
  } catch (error) {
    console.error("generate-action rate limiter unavailable", {
      requestId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return jsonResponse(
      503,
      { error: "service temporarily unavailable", requestId },
      origin,
      requestId,
    );
  }

  const rateHeaders: HeadersInit = {
    "RateLimit-Limit": String(config.rateLimitMaxRequests),
    "RateLimit-Remaining": String(rateLimit.remaining),
    "RateLimit-Reset": rateLimit.resetAt,
  };
  if (!rateLimit.allowed) {
    const resetMs = Date.parse(rateLimit.resetAt) - Date.now();
    const retryAfter = String(Math.max(1, Math.ceil(resetMs / 1_000)));
    return jsonResponse(
      429,
      { error: "rate limit exceeded", requestId },
      origin,
      requestId,
      { ...rateHeaders, "Retry-After": retryAfter },
    );
  }

  try {
    const prompt = buildGenerationPrompt(validatedInput.value, new Date());
    const generated = await callOpenAi(config, prompt);
    const validatedAction = validateActionCard(generated.action);
    if (!validatedAction.ok) throw new Error(`invalid generated action: ${validatedAction.error}`);

    return jsonResponse(
      200,
      { action: validatedAction.value, provider: generated.metadata, requestId },
      origin,
      requestId,
      rateHeaders,
    );
  } catch (error) {
    console.error("generate-action provider failure", {
      requestId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return jsonResponse(
      502,
      { error: "action generation failed", requestId },
      origin,
      requestId,
      rateHeaders,
    );
  }
});
