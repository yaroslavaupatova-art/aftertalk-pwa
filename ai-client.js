(function attachAfterTalkAIClient(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AfterTalkAIClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createAfterTalkAIClient() {
  'use strict';

  const LIMITS = Object.freeze({
    rawNote: 6000,
    profileField: 800,
    contextField: 800,
    profile: 4000,
    style: 2000,
    context: 8000,
    timezone: 64,
    requestBytes: 32000,
    contactName: 160,
    companyName: 200,
    whatHappened: 1000,
    whatMatters: 1000,
    nextStep: 500,
    why: 1000,
    followUpDraft: 4000,
  });
  const PROFILE_FIELDS = ['name', 'role', 'company', 'services', 'positioning'];
  const STYLE_FIELDS = ['voiceStyle', 'followUpStyle'];
  const CONTEXT_FIELDS = ['label', 'dates', 'goals'];
  const PRIORITIES = new Set(['Now', 'Soon', 'Later']);

  class AIClientError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = 'AIClientError';
      this.code = code;
      if (cause) this.cause = cause;
    }
  }

  function boundedText(value, maxLength) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
  }

  function boundedFields(source, fields, maxLength) {
    const input = source && typeof source === 'object' ? source : {};
    return fields.reduce((result, field) => {
      result[field] = boundedText(input[field], maxLength);
      return result;
    }, {});
  }

  function serializeFields(source, fields, fieldMaxLength, maxLength) {
    const selected = boundedFields(source, fields, fieldMaxLength);
    let serialized = JSON.stringify(selected);
    for (let index = fields.length - 1; serialized.length > maxLength && index >= 0; index -= 1) {
      const field = fields[index];
      const value = selected[field];
      let lower = 0;
      let upper = value.length;
      while (lower < upper) {
        const candidateLength = Math.ceil((lower + upper) / 2);
        selected[field] = value.slice(0, candidateLength);
        if (JSON.stringify(selected).length <= maxLength) lower = candidateLength;
        else upper = candidateLength - 1;
      }
      selected[field] = value.slice(0, lower);
      serialized = JSON.stringify(selected);
    }
    return serialized;
  }

  function validTimeZone(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > LIMITS.timezone) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format(new Date(0));
      return true;
    } catch {
      return false;
    }
  }

  function resolvedTimeZone(override) {
    if (override !== undefined) return validTimeZone(override) ? override.trim() : 'UTC';
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (validTimeZone(detected)) return detected.trim();
    } catch {
      // Use the backend's documented default when browser timezone detection is unavailable.
    }
    return 'UTC';
  }

  function utf8Length(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const codePoint = value.codePointAt(index);
      if (codePoint <= 0x7f) bytes += 1;
      else if (codePoint <= 0x7ff) bytes += 2;
      else if (codePoint <= 0xffff) bytes += 3;
      else {
        bytes += 4;
        index += 1;
      }
    }
    return bytes;
  }

  function requestByteLength(payload) {
    return utf8Length(JSON.stringify(payload));
  }

  function fitRequestBytes(payload) {
    const shrinkable = [
      ['style', STYLE_FIELDS],
      ['profile', PROFILE_FIELDS],
      ['context', CONTEXT_FIELDS],
    ];
    for (const [payloadKey, fields] of shrinkable) {
      const selected = JSON.parse(payload[payloadKey]);
      for (let index = fields.length - 1; requestByteLength(payload) > LIMITS.requestBytes && index >= 0; index -= 1) {
        const field = fields[index];
        const value = selected[field];
        let lower = 0;
        let upper = value.length;
        while (lower < upper) {
          const candidateLength = Math.ceil((lower + upper) / 2);
          selected[field] = value.slice(0, candidateLength);
          payload[payloadKey] = JSON.stringify(selected);
          if (requestByteLength(payload) <= LIMITS.requestBytes) lower = candidateLength;
          else upper = candidateLength - 1;
        }
        selected[field] = value.slice(0, lower);
        payload[payloadKey] = JSON.stringify(selected);
      }
      if (requestByteLength(payload) <= LIMITS.requestBytes) return payload;
    }

    const noteCodePoints = Array.from(payload.notes);
    let lower = 0;
    let upper = noteCodePoints.length;
    while (lower < upper) {
      const candidateLength = Math.ceil((lower + upper) / 2);
      payload.notes = noteCodePoints.slice(0, candidateLength).join('');
      if (requestByteLength(payload) <= LIMITS.requestBytes) lower = candidateLength;
      else upper = candidateLength - 1;
    }
    payload.notes = noteCodePoints.slice(0, lower).join('');
    if (!payload.notes || requestByteLength(payload) > LIMITS.requestBytes) {
      throw new AIClientError('invalid-input', 'The note cannot fit within the request size limit.');
    }
    return payload;
  }

  function buildPayload(rawNote, profile, temporaryContext, timezone) {
    const note = boundedText(rawNote, LIMITS.rawNote);
    if (!note) throw new AIClientError('invalid-input', 'Add a note before creating a next step.');
    return fitRequestBytes({
      notes: note,
      profile: serializeFields(profile, PROFILE_FIELDS, LIMITS.profileField, LIMITS.profile),
      style: serializeFields(profile, STYLE_FIELDS, LIMITS.profileField, LIMITS.style),
      context: serializeFields(temporaryContext, CONTEXT_FIELDS, LIMITS.contextField, LIMITS.context),
      timezone: resolvedTimeZone(timezone),
    });
  }

  function isConfigured(config) {
    if (!config || config.enabled !== true) return false;
    const key = boundedText(config.publishableKey, 4096);
    if (!key) return false;
    try {
      const url = new URL(String(config.functionUrl || ''));
      return url.protocol === 'https:' && Boolean(url.host);
    } catch {
      return false;
    }
  }

  function validatedText(card, field, maxLength, required) {
    if (typeof card[field] !== 'string') {
      throw new AIClientError('invalid-card', `AI response contains an invalid ${field}.`);
    }
    const value = card[field].replace(/\s+/g, ' ').trim();
    if (value.length > maxLength || (required && !value)) {
      throw new AIClientError('invalid-card', `AI response contains an invalid ${field}.`);
    }
    return value;
  }

  function localDateTimeValue(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function createId(now) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function validateActionCard(candidate, rawNote, now = new Date()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new AIClientError('invalid-card', 'AI response did not contain an action card.');
    }
    const expectedFields = [
      'contactName', 'companyName', 'whatHappened', 'whatMatters', 'nextStep', 'why',
      'followUpDraft', 'dueAt', 'dueDateMissing', 'priority', 'missingInformation', 'confidence',
    ];
    const keys = Object.keys(candidate);
    if (keys.length !== expectedFields.length || keys.some((key) => !expectedFields.includes(key))) {
      throw new AIClientError('invalid-card', 'AI response contains an unexpected action-card shape.');
    }
    if (typeof candidate.dueAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(candidate.dueAt)) {
      throw new AIClientError('invalid-card', 'AI response contains an invalid due date.');
    }
    const dueAt = new Date(candidate.dueAt);
    if (Number.isNaN(dueAt.getTime())) {
      throw new AIClientError('invalid-card', 'AI response contains an invalid due date.');
    }
    if (typeof candidate.dueDateMissing !== 'boolean') {
      throw new AIClientError('invalid-card', 'AI response contains an invalid due-date-missing signal.');
    }
    if (!PRIORITIES.has(candidate.priority)) {
      throw new AIClientError('invalid-card', 'AI response contains an invalid priority.');
    }
    if (!Array.isArray(candidate.missingInformation) || candidate.missingInformation.length > 12) {
      throw new AIClientError('invalid-card', 'AI response contains invalid missing-information flags.');
    }
    const missingInformation = candidate.missingInformation.map((item) => {
      if (typeof item !== 'string') {
        throw new AIClientError('invalid-card', 'AI response contains invalid missing-information flags.');
      }
      const value = item.replace(/\s+/g, ' ').trim();
      if (!value || value.length > 240) {
        throw new AIClientError('invalid-card', 'AI response contains invalid missing-information flags.');
      }
      return value.toLowerCase() === 'due date' ? 'Due date' : value;
    });
    const hasDueDateFlag = missingInformation.includes('Due date');
    if (candidate.dueDateMissing !== hasDueDateFlag) {
      throw new AIClientError('invalid-card', 'AI response contains inconsistent missing due-date state.');
    }
    if (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
      throw new AIClientError('invalid-card', 'AI response contains an invalid confidence value.');
    }
    const note = boundedText(rawNote, LIMITS.rawNote);
    return {
      id: createId(now),
      createdAt: now.toISOString(),
      rawNote: note,
      contactName: validatedText(candidate, 'contactName', LIMITS.contactName, false),
      companyName: validatedText(candidate, 'companyName', LIMITS.companyName, false),
      whatHappened: validatedText(candidate, 'whatHappened', LIMITS.whatHappened, true),
      whatMatters: validatedText(candidate, 'whatMatters', LIMITS.whatMatters, true),
      nextStep: validatedText(candidate, 'nextStep', LIMITS.nextStep, true),
      why: validatedText(candidate, 'why', LIMITS.why, true),
      followUpDraft: validatedText(candidate, 'followUpDraft', LIMITS.followUpDraft, true),
      dueAt: dueAt.toISOString(),
      dueLocal: localDateTimeValue(dueAt),
      dueDateMissing: candidate.dueDateMissing,
      priority: candidate.priority,
      missingInformation,
      confidence: candidate.confidence,
      calendarStatus: 'draft',
    };
  }

  function responseCard(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body.action;
  }

  async function generateActionCard(options) {
    const input = options && typeof options === 'object' ? options : {};
    const config = input.config || {};
    if (!isConfigured(config)) {
      throw new AIClientError('config-disabled', 'AI generation is not configured.');
    }
    const payload = buildPayload(input.rawNote, input.profile, input.temporaryContext, input.timezone);
    const fetchImpl = input.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchImpl) throw new AIClientError('fetch-unavailable', 'This browser cannot reach the AI service.');

    const configuredTimeout = Number(config.timeoutMs);
    const timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(30000, Math.max(50, configuredTimeout))
      : 12000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(String(config.functionUrl), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          apikey: String(config.publishableKey),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        const status = response && Number.isFinite(response.status) ? response.status : 'unknown';
        throw new AIClientError('http-error', `AI service returned HTTP ${status}.`);
      }

      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new AIClientError('malformed-response', 'AI service returned malformed JSON.', error);
      }
      return validateActionCard(responseCard(body), payload.notes);
    } catch (error) {
      if (error instanceof AIClientError) throw error;
      if (controller.signal.aborted || (error && error.name === 'AbortError')) {
        throw new AIClientError('timeout', 'AI generation timed out.', error);
      }
      throw new AIClientError('network-error', 'AI service could not be reached.', error);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    AIClientError,
    LIMITS,
    buildPayload,
    isConfigured,
    validateActionCard,
    generateActionCard,
  };
});
