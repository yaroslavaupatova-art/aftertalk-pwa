const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const logic = require('../logic.js');

const profile = {
  name: 'Alex Morgan',
  role: 'Consultant',
  company: 'SignalWorks',
  services: 'Market research and growth strategy',
  positioning: 'Turn scattered AI work into reliable infrastructure',
  voiceStyle: 'Direct, warm, and specific',
  followUpStyle: 'Brief and human',
};
const context = {
  label: 'Nordic Growth Forum',
  dates: '14–16 October',
  goals: 'Find relevant partnerships and client opportunities',
};
const note = 'I spoke with Anna from Northstar. They may need a Nordic market-entry research partner in November. I promised I would send our AI research case on Friday. I should connect with her and suggest a short call next week.';
const now = new Date('2026-10-14T09:00:00Z');
const card = logic.generateActionCard(note, profile, context, now);

assert.equal(
  logic.contextPrivacyDisclosure(false),
  'AI is off. Your profile and active context are not sent for generation. Context history remains in this browser.',
);
assert.equal(
  logic.contextPrivacyDisclosure(true),
  'When you request a result, your profile fields and active context are sent for AI generation. Context history remains in this browser.',
);

const missingDueCard = {
  ...card,
  dueAt: now.toISOString(),
  dueLocal: logic.localDateTimeValue(now),
  dueDateMissing: true,
  missingInformation: ['Company name', ' dUE   DaTE '],
};
assert.deepEqual(logic.reviewDueState(missingDueCard), {
  value: '',
  valid: false,
  warning: 'Add a valid date and time before preparing a calendar task.',
});
assert.equal(logic.applyReviewDueDate(missingDueCard, ''), false);
assert.equal(missingDueCard.dueDateMissing, true);
assert.deepEqual(missingDueCard.missingInformation, ['Company name', ' dUE   DaTE ']);
assert.equal(logic.applyReviewDueDate(missingDueCard, 'not-a-date'), false);
assert.equal(missingDueCard.dueDateMissing, true);
assert.equal(logic.applyReviewDueDate(missingDueCard, '2026-10-17T14:30'), true);
assert.equal(missingDueCard.dueAt, new Date('2026-10-17T14:30').toISOString());
assert.equal(missingDueCard.dueDateMissing, false);
assert.deepEqual(missingDueCard.missingInformation, ['Company name']);

assert.equal(card.contactName, 'Anna');
assert.equal(card.companyName, 'Northstar');
assert.match(card.whatMatters, /Nordic market-entry/);
assert.match(card.nextStep, /Send our AI research case on Friday/);
assert.match(card.followUpDraft, /Hi Anna/);
assert.match(card.followUpDraft, /Alex Morgan/);
assert.equal(card.dueDateMissing, false);

const anonymousCard = logic.generateActionCard(note, { name: '', followUpStyle: 'Brief' }, {}, now);
assert.doesNotMatch(anonymousCard.followUpDraft, /Your name/);
assert.equal(new Date(card.dueAt).getDay(), 5);

const googleUrl = new URL(logic.buildGoogleCalendarUrl(card));
assert.equal(googleUrl.hostname, 'calendar.google.com');
assert.equal(googleUrl.searchParams.get('action'), 'TEMPLATE');
assert.equal(googleUrl.searchParams.get('text'), card.nextStep);
assert.match(googleUrl.searchParams.get('details'), /FOLLOW-UP DRAFT/);

const ics = logic.buildIcs(card, now);
assert.match(ics, /BEGIN:VCALENDAR/);
assert.match(ics, /TRIGGER:-PT30M/);
assert.match(ics, /SUMMARY:Send our AI research case on Friday/);
assert.match(ics, /END:VCALENDAR/);

const serviceWorker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
assert.match(serviceWorker, /runtime-config\.js/);
assert.match(serviceWorker, /fetch\(event\.request, \{ cache: 'no-store' \}\)/);
assert.match(serviceWorker, /response\.status === 200/);
assert.match(serviceWorker, /catch\([\s\S]*caches\.match\(event\.request\)/);
assert.match(serviceWorker, /key\.startsWith\('aftertalk-web-'\)/);
assert.doesNotMatch(serviceWorker, /keys\.filter\(\(key\) => key !== CACHE\)/);

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
assert.match(appSource, /contextPrivacyDisclosure/);
assert.match(appSource, /review-due-warning/);
assert.match(appSource, /function isAppleMobile\(\)/);
assert.match(appSource, /Use the microphone on your iPhone keyboard/);
assert.match(appSource, /event\.error === 'not-allowed'/);
assert.match(appSource, /recognition\.continuous = !isAppleBrowser/);

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert.match(indexSource, /id="context-data-disclosure"/);
assert.match(indexSource, /id="review-due-warning"/);

const migrationSource = fs.readFileSync(path.join(
  __dirname, '..', 'supabase', 'migrations', '20261014000000_generate_action_rate_limit.sql',
), 'utf8');
assert.match(migrationSource, /create index if not exists[\s\S]*window_started_at/i);
assert.match(migrationSource, /delete from public\.generate_action_rate_limits[\s\S]*interval '48 hours'/i);

const denoConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'deno.json'), 'utf8'));
assert.match(denoConfig.tasks.check, /deno check functions\/generate-action\/index\.ts/);

const privacySource = fs.readFileSync(path.join(__dirname, '..', 'privacy.html'), 'utf8');
assert.match(privacySource, /salted SHA-256 fingerprint from the request IP address/);
assert.doesNotMatch(privacySource, /IP address and user-agent value/);

console.log(JSON.stringify({
  status: 'passed',
  dependencies: 0,
  contact: card.contactName,
  company: card.companyName,
  nextStep: card.nextStep,
  dueAt: card.dueAt,
  googleCalendarPayload: 'valid',
  appleIcsPayload: 'valid',
  appleReminder: '30 minutes before',
  runtimeConfigCaching: 'network-first with no-store and cached offline fallback',
}, null, 2));
