(function attachAfterTalkVoiceClient(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AfterTalkVoiceClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createAfterTalkVoiceClient() {
  'use strict';

  const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
  const MAX_TRANSCRIPT_CHARS = 6000;
  const SUPPORTED_TYPES = new Set([
    'audio/mp4',
    'audio/m4a',
    'audio/webm',
    'audio/ogg',
    'audio/wav',
  ]);

  class VoiceClientError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = 'VoiceClientError';
      this.code = code;
      if (cause) this.cause = cause;
    }
  }

  function normalizedMimeType(value) {
    return String(value || '').split(';', 1)[0].trim().toLowerCase();
  }

  function filenameForMimeType(mimeType) {
    const type = normalizedMimeType(mimeType);
    if (type === 'audio/mp4' || type === 'audio/m4a') return 'aftertalk-note.m4a';
    if (type === 'audio/ogg') return 'aftertalk-note.ogg';
    if (type === 'audio/wav') return 'aftertalk-note.wav';
    return 'aftertalk-note.webm';
  }

  function validateAudio(audioBlob) {
    if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
      throw new VoiceClientError('invalid-audio', 'No voice recording was captured.');
    }
    if (audioBlob.size > MAX_AUDIO_BYTES) {
      throw new VoiceClientError('audio-too-large', 'The recording is too long. Keep voice notes under 90 seconds.');
    }
    const mimeType = normalizedMimeType(audioBlob.type);
    if (!SUPPORTED_TYPES.has(mimeType)) {
      throw new VoiceClientError('unsupported-audio', 'This browser created an unsupported audio format.');
    }
    return mimeType;
  }

  async function transcribeAudio(audioBlob, config, fetchImpl = globalThis.fetch) {
    const mimeType = validateAudio(audioBlob);
    if (!config || config.enabled !== true || !config.transcriptionUrl || !config.publishableKey) {
      throw new VoiceClientError('disabled', 'Voice transcription is not configured.');
    }
    if (typeof fetchImpl !== 'function') {
      throw new VoiceClientError('unavailable', 'Voice transcription is unavailable in this browser.');
    }

    const form = new FormData();
    form.append('audio', audioBlob, filenameForMimeType(mimeType));
    const configuredTimeout = Number(config.transcriptionTimeoutMs);
    const timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(60000, Math.max(5000, configuredTimeout))
      : 45000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(String(config.transcriptionUrl), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          apikey: String(config.publishableKey),
        },
        body: form,
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        const status = response && Number.isFinite(response.status) ? response.status : 'unknown';
        throw new VoiceClientError('http-error', `Voice service returned HTTP ${status}.`);
      }
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new VoiceClientError('invalid-response', 'Voice service returned an unreadable response.', error);
      }
      const text = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
      if (!text || text.length > MAX_TRANSCRIPT_CHARS) {
        throw new VoiceClientError('invalid-response', 'Voice service returned an invalid transcript.');
      }
      return text;
    } catch (error) {
      if (error instanceof VoiceClientError) throw error;
      if (error && error.name === 'AbortError') {
        throw new VoiceClientError('timeout', 'Voice transcription timed out.', error);
      }
      throw new VoiceClientError('network', 'Voice transcription could not reach the service.', error);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    MAX_AUDIO_BYTES,
    MAX_TRANSCRIPT_CHARS,
    SUPPORTED_TYPES,
    VoiceClientError,
    filenameForMimeType,
    normalizedMimeType,
    transcribeAudio,
    validateAudio,
  };
});
