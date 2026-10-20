# AfterTalk production checklist

Owner handoff for the private pilot. Keep credentials in Supabase/OpenAI dashboards or the local untracked environment file, never in this repository.

## Accounts, billing, and deployment

1. [ ] **Create the Supabase project.** Record the project reference, project URL, `generate-action` function URL, and default publishable key in the owner’s password manager or private deployment notes. Confirm who owns the project and billing account.
2. [ ] **Apply the database migration.** Ask the technical deployer to link the Supabase CLI to the production project and run `supabase db push`. Confirm the `generate_action_rate_limits` table and `consume_generate_action_rate_limit` function exist.
3. [ ] **Set the Edge Function configuration.** Set `OPENAI_API_KEY`, `OPENAI_MODEL`, `ALLOWED_ORIGINS`, and `RATE_LIMIT_SALT` in Supabase. `ALLOWED_ORIGINS` must contain the exact GitHub Pages origin, without a path or wildcard. Generate a unique salt of at least 32 random characters. Confirm the Supabase runtime provides `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, and `SUPABASE_SECRET_KEYS`; keep secret keys server-only.
4. [ ] **Deploy the authenticated function.** Deploy `generate-action`. Confirm `supabase/config.toml` has `verify_jwt = false` and the function still authenticates the `apikey` with `createSupabaseContext(..., { auth: "publishable" })`. Publishable keys are not JWTs; disabling the legacy gateway check must not make the handler unauthenticated.
5. [ ] **Configure the browser app.** Put the deployed function URL in `runtime-config.js` as `functionUrl` and the Supabase default publishable key as `publishableKey`. These two values are public by design. Do not put the OpenAI key, Supabase secret key, rate-limit salt, passwords, or other secrets in this file. Set `enabled: true` only for the production-ready build.
6. [ ] **Set OpenAI spending controls.** In the production OpenAI project, add a payment method if required, set a budget alert and the strictest practical usage cap, and confirm who receives billing alerts. Treat the provider-side cap as the final cost boundary: Origin filtering is a browser abuse control, not authentication for non-browser clients.
7. [ ] **Test the live endpoint before publishing.** From an allowed origin, confirm a valid request returns a reviewed Action Card and rate-limit headers. Confirm a disallowed or missing Origin is rejected for POST and OPTIONS. Confirm the same platform-forwarded IP stays in one rate-limit bucket when User-Agent changes. Inspect application logs to confirm they do not contain note/profile text or raw IP addresses. Force an endpoint failure and confirm the browser clearly labels and uses the deterministic on-device fallback.
8. [ ] **Run the release checks.** Run every command under **Local development** in `README.md`. All Node, Deno, HTML, and local browser checks must pass. Confirm `runtime-config.js` remains network-first with `cache: 'no-store'` so installed users receive AI enablement and rollback changes, with the cached copy used only offline.
9. [ ] **Publish to GitHub Pages.** Increment the `CACHE` version in `sw.js` for every static release; never reuse a service-worker cache version. Publish the static files over HTTPS only after the live endpoint and release checks pass.
10. [ ] **Verify production.** In a clean browser profile:
    - confirm the production origin is accepted and an unapproved origin is rejected;
    - create and review one AI card, checking its name, action, draft, and date;
    - confirm the privacy notice and pilot terms load;
    - confirm Google Calendar opens a prefilled page but saves nothing until **Save** is clicked;
    - confirm Apple Calendar downloads an `.ics` file with a 30-minute reminder and requires **Add** confirmation;
    - confirm profile/history survive a reload and disappear after site data is cleared.
11. [ ] **Complete the private handoff note.** Record the production URL, Supabase and OpenAI account owners, billing-alert recipient, deployment date, and rollback owner.
