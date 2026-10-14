const assert = require('node:assert/strict');
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

assert.equal(card.contactName, 'Anna');
assert.equal(card.companyName, 'Northstar');
assert.match(card.whatMatters, /Nordic market-entry/);
assert.match(card.nextStep, /Send our AI research case on Friday/);
assert.match(card.followUpDraft, /Hi Anna/);
assert.match(card.followUpDraft, /Alex Morgan/);

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
}, null, 2));
