const assert = require('node:assert/strict');
const voice = require('../voice-client.js');

const config = {
  enabled: true,
  transcriptionUrl: 'https://example.supabase.co/functions/v1/transcribe-note',
  publishableKey: 'sb_publishable_test',
  transcriptionTimeoutMs: 5000,
};

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

(async () => {
  assert.equal(voice.normalizedMimeType('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(voice.filenameForMimeType('audio/mp4'), 'aftertalk-note.m4a');
  assert.equal(voice.filenameForMimeType('audio/webm;codecs=opus'), 'aftertalk-note.webm');

  const audio = new Blob(['voice-bytes'], { type: 'audio/webm;codecs=opus' });
  let request;
  const transcript = await voice.transcribeAudio(audio, config, async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ text: '  I met Anna.\nSend the case tomorrow.  ' }),
    };
  });
  assert.equal(transcript, 'I met Anna. Send the case tomorrow.');
  assert.equal(request.url, config.transcriptionUrl);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.apikey, config.publishableKey);
  assert.equal(request.options.headers['Content-Type'], undefined);
  assert.ok(request.options.body instanceof FormData);
  const uploaded = request.options.body.get('audio');
  assert.ok(uploaded instanceof Blob);
  assert.equal(uploaded.type, 'audio/webm;codecs=opus');

  await expectCode(voice.transcribeAudio(new Blob([], { type: 'audio/webm' }), config), 'invalid-audio');
  await expectCode(voice.transcribeAudio(new Blob(['x'], { type: 'audio/aac' }), config), 'unsupported-audio');
  await expectCode(voice.transcribeAudio(audio, { ...config, enabled: false }), 'disabled');
  await expectCode(voice.transcribeAudio(audio, config, async () => ({ ok: false, status: 429 })), 'http-error');
  await expectCode(voice.transcribeAudio(audio, config, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ text: '' }),
  })), 'invalid-response');
  await expectCode(voice.transcribeAudio(audio, config, async () => {
    throw new TypeError('network down');
  }), 'network');

  console.log(JSON.stringify({
    status: 'passed',
    cases: [
      'MIME normalization and upload filename',
      'multipart request with publishable key and no manual content-type boundary',
      'transcript normalization',
      'empty audio rejection',
      'unsupported audio rejection',
      'disabled configuration',
      'non-2xx response',
      'invalid transcript response',
      'network failure',
    ],
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
