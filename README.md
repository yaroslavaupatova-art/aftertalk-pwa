# AfterTalk — Lightweight Public PWA

A dependency-free, mobile-first Progressive Web App. It can be hosted as static files on any HTTPS host and does not require Apple App Store or Google Play distribution.

## User access

1. Open the public URL.
2. Use the app directly in the browser.
3. Optionally choose **Install** or **Add to Home Screen**.

## Current capabilities

- Personal/company context stored locally in the user’s browser
- Temporary event/project context
- Reusable history for previously saved event/project contexts
- Preferred calendar selected before note capture
- Typed capture
- Browser speech recognition where supported
- Phone keyboard dictation as a fallback
- Local capture-to-action rules engine
- Editable next step and rough follow-up
- Suggested deadline
- Google Calendar handoff for confirmation
- Apple Calendar `.ics` download with a 30-minute alarm
- Recent actions stored locally
- Offline app shell after first visit
- No framework, package manager, marketplace, account, or paid API

## Important pilot limitation

This version stores data only on the user’s device and uses a deterministic local rules engine rather than a production AI model. Clearing site data removes the profile and action history. Cross-device sync, accounts, production transcription, and advanced AI require a secure backend.

The public build starts with a blank personal profile. Each pilot user adds their own context locally. See `privacy.html` and `terms.html` for the notices included in the app.

## Run locally

```bash
python3 -m http.server 8087 --directory .
```

Then open `http://localhost:8087`.

## Deploy

Upload the contents of this directory to a static HTTPS host. The host must serve `index.html` and `sw.js` from the same published directory.

All asset, manifest, and service-worker paths are relative, so the same build can be hosted at a root domain or a GitHub Pages project path.

## Verification

```bash
node --check logic.js
node --check app.js
node tests/smoke.cjs
```
