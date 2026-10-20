const assert = require('node:assert/strict');
const aiClient = require('../ai-client.js');

const enabledConfig = {
  enabled: true,
  functionUrl: 'https://example.supabase.co/functions/v1/action-card',
  publishableKey: 'sb_publishable_test_key',
  timeoutMs: 200,
};
const validResponse = {
  action: {
    contactName: 'Anna',
    companyName: 'Northstar',
    whatHappened: 'Anna described a market-entry project.',
    whatMatters: 'Northstar may need a Nordic market-entry research partner.',
    nextStep: 'Send the AI research case on Friday',
    why: 'This follows through on a specific promise.',
    followUpDraft: 'Hi Anna — here is the research case I mentioned.',
    dueAt: '2026-10-16T10:00:00.000Z',
    dueDateMissing: false,
    priority: 'Soon',
    missingInformation: [],
    confidence: 0.92,
  },
  provider: { provider: 'openai', model: 'test-model' },
  requestId: 'request-test-123',
};

async function run() {
  let request;
  const longNote = `  ${'Conversation detail '.repeat(500)}  `;
  const card = await aiClient.generateActionCard({
    rawNote: longNote,
    profile: {
      followUpStyle: 'One practical next step',
      services: 'Research',
      ignoredSecret: 'must-not-be-sent',
      voiceStyle: 'Warm & direct',
      name: 'Alex',
    },
    temporaryContext: { label: 'Forum', goals: 'Partnerships', extra: 'must-not-be-sent' },
    timezone: 'Europe/Helsinki',
    config: enabledConfig,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => validResponse };
    },
  });

  assert.equal(request.url, enabledConfig.functionUrl);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.apikey, enabledConfig.publishableKey);
  assert.equal(request.options.headers.Authorization, undefined);
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(payload), ['notes', 'profile', 'style', 'context', 'timezone']);
  assert.ok(payload.notes.length > 0 && payload.notes.length <= aiClient.LIMITS.rawNote);
  assert.equal(
    payload.profile,
    '{"name":"Alex","role":"","company":"","services":"Research","positioning":""}',
  );
  assert.equal(
    payload.style,
    '{"voiceStyle":"Warm & direct","followUpStyle":"One practical next step"}',
  );
  assert.equal(payload.context, '{"label":"Forum","dates":"","goals":"Partnerships"}');
  assert.equal(payload.timezone, 'Europe/Helsinki');
  assert.ok(Object.values(payload).every((value) => typeof value === 'string'));
  assert.equal(payload.schemaVersion, undefined);
  assert.equal(payload.rawNote, undefined);
  assert.equal(payload.temporaryContext, undefined);
  assert.equal(card.nextStep, validResponse.action.nextStep);
  assert.equal(card.rawNote, payload.notes);
  assert.equal(card.calendarStatus, 'draft');
  assert.equal(card.dueAt, validResponse.action.dueAt);
  assert.equal(card.dueDateMissing, false);
  assert.deepEqual(card.missingInformation, []);
  assert.equal(card.confidence, 0.92);

  const fallbackTimezonePayload = aiClient.buildPayload('A note', {}, {}, 'Mars/Olympus');
  assert.equal(fallbackTimezonePayload.timezone, 'UTC');
  const detectedTimezonePayload = aiClient.buildPayload('A note');
  const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(detectedTimezonePayload.timezone, detectedTimezone || 'UTC');
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: detectedTimezonePayload.timezone }));

  const boundedPayload = aiClient.buildPayload('A note', {
    name: '"'.repeat(aiClient.LIMITS.profileField),
    role: '"'.repeat(aiClient.LIMITS.profileField),
    company: '"'.repeat(aiClient.LIMITS.profileField),
    services: '"'.repeat(aiClient.LIMITS.profileField),
    positioning: '"'.repeat(aiClient.LIMITS.profileField),
    voiceStyle: '"'.repeat(aiClient.LIMITS.profileField),
    followUpStyle: '"'.repeat(aiClient.LIMITS.profileField),
  }, { label: 'Context', extra: 'must-not-be-sent' }, 'UTC');
  assert.ok(boundedPayload.profile.length <= aiClient.LIMITS.profile);
  assert.ok(boundedPayload.style.length <= aiClient.LIMITS.style);
  assert.ok(Buffer.byteLength(JSON.stringify(boundedPayload)) <= aiClient.LIMITS.requestBytes);
  assert.deepEqual(Object.keys(JSON.parse(boundedPayload.profile)), [
    'name', 'role', 'company', 'services', 'positioning',
  ]);
  assert.deepEqual(Object.keys(JSON.parse(boundedPayload.style)), ['voiceStyle', 'followUpStyle']);
  assert.deepEqual(Object.keys(JSON.parse(boundedPayload.context)), ['label', 'dates', 'goals']);

  const escapedNote = '\u0000'.repeat(aiClient.LIMITS.rawNote);
  const escapedPayload = aiClient.buildPayload(escapedNote, {}, {}, 'UTC');
  const untrimmedEscapedPayload = { ...escapedPayload, notes: escapedNote };
  assert.ok(
    Buffer.byteLength(JSON.stringify(untrimmedEscapedPayload), 'utf8') > aiClient.LIMITS.requestBytes,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(escapedPayload), 'utf8') <= aiClient.LIMITS.requestBytes);
  assert.ok(escapedPayload.notes.length > 0);

  const boundaryAction = {
    ...validResponse.action,
    contactName: 'c'.repeat(160),
    companyName: 'o'.repeat(200),
    whatHappened: 'h'.repeat(1000),
    whatMatters: 'm'.repeat(1000),
    nextStep: 'n'.repeat(500),
    why: 'w'.repeat(1000),
    followUpDraft: 'f'.repeat(4000),
    dueDateMissing: true,
    missingInformation: [' dUE   DaTe '],
  };
  const boundaryCard = aiClient.validateActionCard(boundaryAction, 'Boundary note', new Date(0));
  assert.equal(boundaryCard.followUpDraft.length, 4000);
  assert.deepEqual(boundaryCard.missingInformation, ['Due date']);
  assert.equal(boundaryCard.dueDateMissing, true);

  const lowercaseDueFlag = aiClient.validateActionCard({
    ...validResponse.action,
    dueDateMissing: true,
    missingInformation: ['due date'],
  }, 'A note');
  assert.deepEqual(lowercaseDueFlag.missingInformation, ['Due date']);
  assert.equal(lowercaseDueFlag.dueDateMissing, true);

  for (const inconsistentAction of [
    { ...validResponse.action, dueDateMissing: true, missingInformation: [] },
    { ...validResponse.action, dueDateMissing: false, missingInformation: [' dUe  DATE '] },
  ]) {
    assert.throws(
      () => aiClient.validateActionCard(inconsistentAction, 'A note'),
      (error) => error instanceof aiClient.AIClientError && error.code === 'invalid-card',
    );
  }
  const missingDueDateSignal = { ...validResponse.action };
  delete missingDueDateSignal.dueDateMissing;
  assert.throws(
    () => aiClient.validateActionCard(missingDueDateSignal, 'A note'),
    (error) => error instanceof aiClient.AIClientError && error.code === 'invalid-card',
  );
  for (const field of ['whatHappened', 'whatMatters', 'nextStep', 'why', 'followUpDraft']) {
    assert.throws(
      () => aiClient.validateActionCard({ ...validResponse.action, [field]: ' \n\t ' }, 'A note'),
      (error) => error instanceof aiClient.AIClientError && error.code === 'invalid-card',
    );
  }

  await assert.rejects(
    aiClient.generateActionCard({
      rawNote: 'A valid note',
      config: enabledConfig,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ action: { nextStep: 'Missing required fields', dueAt: 'not-a-date' } }),
      }),
    }),
    (error) => error instanceof aiClient.AIClientError && error.code === 'invalid-card',
  );

  await assert.rejects(
    aiClient.generateActionCard({
      rawNote: 'A valid note',
      config: enabledConfig,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('bad json'); },
      }),
    }),
    (error) => error instanceof aiClient.AIClientError && error.code === 'malformed-response',
  );

  await assert.rejects(
    aiClient.generateActionCard({
      rawNote: 'A valid note',
      config: enabledConfig,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    (error) => error instanceof aiClient.AIClientError && error.code === 'http-error',
  );

  await assert.rejects(
    aiClient.generateActionCard({
      rawNote: 'A valid note',
      config: { ...enabledConfig, timeoutMs: 50 },
      fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    }),
    (error) => error instanceof aiClient.AIClientError && error.code === 'timeout',
  );

  let disabledFetchCalled = false;
  await assert.rejects(
    aiClient.generateActionCard({
      rawNote: 'A valid note',
      config: { ...enabledConfig, enabled: false },
      fetchImpl: async () => { disabledFetchCalled = true; },
    }),
    (error) => error instanceof aiClient.AIClientError && error.code === 'config-disabled',
  );
  assert.equal(disabledFetchCalled, false);

  delete globalThis.AfterTalkConfig;
  require('../runtime-config.js');
  assert.equal(globalThis.AfterTalkConfig.enabled, true);
  assert.equal(
    globalThis.AfterTalkConfig.functionUrl,
    'https://ewvfvueqawdcapqdeuac.supabase.co/functions/v1/generate-action',
  );
  assert.match(globalThis.AfterTalkConfig.publishableKey, /^sb_publishable_[A-Za-z0-9_-]+$/);
  assert.equal(globalThis.AfterTalkConfig.timeoutMs, 12000);

  console.log(JSON.stringify({
    status: 'passed',
    cases: [
      'valid AI success, exact serialized request contract, and local raw note',
      'valid timezone resolution and UTC fallback',
      'escaped request payload is capped at 32,000 UTF-8 bytes with a non-empty note',
      'Action Card boundary lengths and required-string semantics',
      'structural missing-due contract, canonicalization, and inconsistency rejection',
      'invalid action card',
      'malformed JSON',
      'non-2xx failure',
      'timeout',
      'disabled configuration without fetch',
      'verified production runtime configuration',
    ],
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
