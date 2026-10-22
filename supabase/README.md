# AfterTalk AI backend

The `generate-action` Edge Function accepts authenticated `POST` requests and returns one validated
Action Card. The `transcribe-note` Edge Function accepts a bounded multipart audio recording and
returns editable text from OpenAI transcription. Because current Supabase publishable keys are not
JWTs, `config.toml` disables the legacy gateway JWT check and both functions authenticate the
`apikey` with `@supabase/server` using `auth: "publishable"`. OpenAI and Supabase secret credentials
remain server-side.

## Request

```json
{
  "notes": "Required source notes",
  "profile": "Optional saved user profile",
  "style": "Optional saved writing style",
  "context": "Optional saved context",
  "timezone": "Europe/Helsinki"
}
```

Unknown fields, invalid JSON, non-JSON content types, oversized values, and non-POST methods are
rejected. Browser requests must come from an exact origin in `ALLOWED_ORIGINS`; local HTTP origins
are accepted only when `ALLOW_LOCALHOST_ORIGINS=true`. A missing Origin is rejected for both POST
and OPTIONS. Origin filtering is a browser abuse control, not authentication for non-browser
clients.

## Deploy

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
cp supabase/.env.example supabase/.env
# Fill supabase/.env locally; it is gitignored.
supabase secrets set --env-file supabase/.env
supabase functions deploy generate-action
supabase functions deploy transcribe-note
```

Clients must send the project's default publishable key in the `apikey` header and use
`Content-Type: application/json` for generation. Transcription clients submit the `audio` field as
`multipart/form-data`; recordings are limited to 10 MB and supported browser audio formats. Do not
replace the in-function publishable-key checks with unauthenticated public handlers.

Use a distinct random `RATE_LIMIT_SALT` of at least 32 characters. `RATE_LIMIT_MAX_REQUESTS`
defaults to 30 and is bounded to 1–300 requests per one-hour bucket. The SQL RPC is atomic,
`SECURITY DEFINER`, and executable only by `service_role`. It indexes counter window start times and
prunes counters older than 48 hours before consuming a request. The fingerprint is derived from the
sanitized platform-forwarded client IP only, so User-Agent rotation does not create a new bucket. If
no usable IP identity is available or the RPC fails, the function fails closed. Provider-side
spending caps and usage limits remain the final cost boundary.

## Verify

```sh
cd supabase
deno task check
```
