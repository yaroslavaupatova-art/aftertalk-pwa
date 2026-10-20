# AfterTalk — release and deployment guide

AfterTalk is a dependency-free, mobile-first Progressive Web App. The browser app is static and is published on GitHub Pages. The production runtime configuration enables AI generation through a Supabase Edge Function; when that service is unavailable or the request origin is not approved, AfterTalk uses its deterministic rules engine in the browser.

## What the app does

- Captures a typed note or text returned by browser/OS speech recognition
- Keeps the profile, saved context history, calendar preference, and prepared actions in browser local storage
- Creates an editable next step, follow-up draft, and suggested date
- Uses the configured AI service when enabled, with an on-device fallback if that service fails
- Opens a prefilled Google Calendar page or downloads an Apple-compatible `.ics` file; the user confirms the event in the calendar service
- Caches the app shell for offline use after the first visit

There are no AfterTalk user accounts or cross-device sync. Clearing site data removes the locally stored profile, context history, preferences, and prepared actions.

## Data flow

### Local browser storage

AfterTalk stores these items on the current browser/device:

- profile and writing preferences
- active temporary context and up to eight saved context-history entries
- preferred calendar
- prepared action history, including the source note and generated draft

This data is not automatically synchronized. The complete saved context history is not sent to the AI service.

### AI enabled

When `runtime-config.js` is valid and `enabled` is `true`, pressing **Make my next step** sends the current note, the saved profile fields, and the active temporary context to the configured Supabase Edge Function. The function validates and bounds the request, applies an origin allowlist and rate limit, and sends the generation prompt to OpenAI. OpenAI returns structured output to the function, which validates it before returning it to the browser.

The OpenAI API key and Supabase secret credential remain on the server. They must never appear in browser code, Git history, GitHub Pages settings, or `runtime-config.js`.

For abuse prevention, the Edge Function derives a salted SHA-256 fingerprint from the request IP address only and stores that fingerprint with a fixed-window usage counter. It does not store the raw IP address in the rate-limit table. User-Agent rotation does not create a new bucket. Counters older than 48 hours are pruned by the atomic rate-limit RPC. This is a data-minimization measure, not a promise of anonymity: Supabase, OpenAI, and network infrastructure may still process connection and service metadata under their own terms and settings.

The exact Origin allowlist is a browser abuse filter, not authentication for non-browser clients; an external client can imitate an Origin header and use the public publishable key. The rate limit reduces abuse, while OpenAI project spending caps and usage limits remain the final cost boundary.

AfterTalk does not upload or store raw audio. If voice capture is used, the browser or operating system may process the speech. AfterTalk receives the resulting text; when AI is enabled and the user requests a result, that text is sent as part of the note.

### AI disabled or unavailable

The production configuration enables AI for the approved GitHub Pages origin. If AI is explicitly disabled, no generation request is sent to Supabase or OpenAI and the deterministic browser rules engine creates the card locally. The same fallback runs if the Edge Function times out, rejects the request (including an unapproved local origin), reaches its rate limit, or OpenAI is unavailable. The fallback is less flexible than AI and all output must still be reviewed.

## Calendar handoffs

- **Google Calendar:** AfterTalk opens `calendar.google.com` with the action, source note, and draft prefilled. Nothing is saved until the user reviews the page and clicks **Save**. Google applies the account's normal notification settings.
- **Apple Calendar:** AfterTalk creates and downloads an `.ics` file containing the action, source note, draft, and a 30-minute reminder. The user opens the file and confirms **Add**. AfterTalk does not write directly to Apple Calendar.

## Browser-safe runtime configuration

`runtime-config.js` is public because every visitor's browser downloads it. These are the only supported fields:

| Field | Purpose |
| --- | --- |
| `enabled` | Must be exactly `true` before remote AI is used; enabled in the production configuration |
| `functionUrl` | HTTPS URL of the deployed `generate-action` Edge Function |
| `publishableKey` | Supabase publishable key authenticated by the Edge Function; public by design |
| `timeoutMs` | Browser request timeout, clamped by the client to 50–30,000 ms |

For a new environment, keep `functionUrl` and `publishableKey` blank until its backend is deployed and verified. The production file contains only the deployed function URL and Supabase publishable key, both public by design. Never add `OPENAI_API_KEY`, Supabase secret keys, `RATE_LIMIT_SALT`, passwords, or other secrets to this file.

The service worker fetches `runtime-config.js` network-first with `cache: 'no-store'`, updates its offline fallback only after a successful HTTP 200 response, and uses that cached config only when the network is unavailable. This ensures installed users receive AI enablement and rollback changes instead of staying on an older cached setting.

## Server-only configuration

Set these as Supabase Edge Function secrets or environment settings:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `ALLOWED_ORIGINS` — exact comma-separated production origins; wildcards are rejected
- `RATE_LIMIT_SALT` — a unique random value of at least 32 characters
- `RATE_LIMIT_MAX_REQUESTS` — optional; defaults to 30 requests per one-hour window
- `OPENAI_TIMEOUT_MS` — optional; defaults to 30 seconds
- `ALLOW_LOCALHOST_ORIGINS` — optional; keep `false` in production

`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, and `SUPABASE_SECRET_KEYS` are supplied by the Supabase runtime. The function validates the browser's default publishable key with `@supabase/server` and uses the default secret key only for its rate-limit RPC. Never expose a secret key to the browser.

## Local development

From the repository root, start a static server:

```sh
python3 -m http.server 8087 --directory .
```

Open `http://localhost:8087/`. Production AI is enabled, but localhost is deliberately absent from the backend origin allowlist, so local generation exercises the clearly labelled on-device fallback unless `ALLOW_LOCALHOST_ORIGINS` is enabled temporarily in a non-production environment.

Run the browser-side checks from a second terminal:

```sh
node --check runtime-config.js
node --check logic.js
node --check ai-client.js
node --check app.js
node --check sw.js
node tests/smoke.cjs
node tests/ai-client.cjs
TARGET_URL=http://127.0.0.1:8087/ node tests/public-ui-qa.cjs
```

The UI QA script uses its checked-in Google Chrome path by default. Set the optional `CHROME_PATH` environment variable to override that path, for example `CHROME_PATH="/path/to/Chrome" TARGET_URL=http://127.0.0.1:8087/ node tests/public-ui-qa.cjs`.

Run the Edge Function formatting, lint, and unit tests:

```sh
cd supabase
deno task check
```

## Production deployment sequence

1. Create the Supabase project and note its project reference, Edge Function URL, and publishable key.
2. Link the Supabase CLI to the project and apply the migration in `supabase/migrations/`.
3. Set `OPENAI_API_KEY`, `OPENAI_MODEL`, exact `ALLOWED_ORIGINS`, and a unique `RATE_LIMIT_SALT`. Confirm the Supabase runtime provides `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, and `SUPABASE_SECRET_KEYS`.
4. Deploy `generate-action`. Keep `verify_jwt = false` because publishable keys are not JWTs; the handler itself must retain `createSupabaseContext(..., { auth: "publishable" })`.
5. Put only the deployed function URL and Supabase publishable key in `runtime-config.js`, then set `enabled: true`.
6. Set an OpenAI project budget alert and the strictest practical usage cap before inviting pilot users. Treat that provider-side cap as the final cost boundary; neither Origin filtering nor the application rate limit is non-browser authentication.
7. Test the live Edge Function with the production origin and Supabase publishable key. Confirm a valid response, rejected disallowed origin, rate-limit headers, and no note/profile content in application logs.
8. Re-run the local browser checks with AI enabled, including an outage/failure test that confirms the deterministic fallback.
9. Increment the `CACHE` version in `sw.js` for every static release, then publish the static files to GitHub Pages over HTTPS. Never reuse a service-worker cache version across releases.
10. Verify the production URL, privacy notice, pilot terms, service-worker scope, AI success state, fallback state, and both calendar handoffs.

Use [`PRODUCTION-CHECKLIST.md`](PRODUCTION-CHECKLIST.md) for the owner handoff and `supabase/README.md` for backend commands.

## Release safeguards

Generated text, dates, names, and recommendations can be wrong or incomplete. Users must review every card and calendar handoff. AfterTalk does not automatically send messages or create calendar events, and it is not a system of record or professional adviser.
