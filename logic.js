(function attachAfterTalkLogic(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AfterTalkLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createAfterTalkLogic() {
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  function sentences(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
  }

  function compact(text, maxLength = 210) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trim()}…`;
  }

  function capitalize(text) {
    const cleaned = String(text || '').trim().replace(/[.?!]+$/, '');
    return cleaned ? `${cleaned[0].toUpperCase()}${cleaned.slice(1)}` : cleaned;
  }

  function extractContact(note) {
    const patterns = [
      /(?:met|spoke with|talked with|talked to|caught up with)\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?)/u,
      /(?:follow up with|send)\s+([A-Z][\p{L}'-]+)/u,
    ];
    for (const pattern of patterns) {
      const match = note.match(pattern);
      if (match && match[1]) return match[1].trim();
    }
    return '';
  }

  function extractCompany(note) {
    const patterns = [
      /\bfrom\s+([A-Z][A-Za-z0-9&-]*(?:\s+[A-Z][A-Za-z0-9&-]*){0,3})/,
      /\bat\s+([A-Z][A-Za-z0-9&-]*(?:\s+[A-Z][A-Za-z0-9&-]*){0,3})/,
    ];
    for (const pattern of patterns) {
      const match = note.match(pattern);
      if (match && match[1]) return match[1].trim();
    }
    return '';
  }

  function extractAction(note) {
    const patterns = [
      /I (?:said|told [^.]+) (?:that )?I (?:would|will)\s+([^.?!]+)/i,
      /I promised (?:that )?I (?:would|will|should)?\s*([^.?!]+)/i,
      /I need to\s+([^.?!]+)/i,
      /I should\s+([^.?!]+)/i,
      /remember to\s+([^.?!]+)/i,
      /(?:next step is|follow-up is|follow up is)\s+([^.?!]+)/i,
    ];
    for (const pattern of patterns) {
      const match = note.match(pattern);
      if (match && match[1]) return capitalize(match[1]);
    }
    const actionSentence = sentences(note).find((sentence) =>
      /\b(send|share|follow up|email|call|schedule|connect|write|prepare|introduce|review|brainstorm)\b/i.test(sentence),
    );
    return actionSentence
      ? capitalize(actionSentence.replace(/^I\s+/i, ''))
      : 'Review this conversation and choose the next useful step';
  }

  function importantSentence(note) {
    const list = sentences(note);
    return compact(
      list.find((sentence) =>
        /\b(need|looking for|interested|opportunity|idea|important|problem|deadline|project|could|may)\b/i.test(sentence),
      ) || list[0] || note,
    );
  }

  function nextNamedDay(date, targetDay) {
    const result = new Date(date);
    let difference = (targetDay - date.getDay() + 7) % 7;
    if (difference === 0) difference = 7;
    result.setDate(result.getDate() + difference);
    result.setHours(10, 0, 0, 0);
    return result;
  }

  function suggestDueDate(note, now = new Date()) {
    const lower = note.toLowerCase();
    const due = new Date(now);
    if (/\btoday\b/.test(lower)) {
      due.setHours(Math.max(now.getHours() + 2, 16), 0, 0, 0);
      return due;
    }
    if (/\btomorrow\b/.test(lower)) {
      due.setDate(due.getDate() + 1);
      due.setHours(10, 0, 0, 0);
      return due;
    }
    for (let day = 0; day < DAY_NAMES.length; day += 1) {
      if (new RegExp(`\\b${DAY_NAMES[day]}\\b`, 'i').test(lower)) return nextNamedDay(now, day);
    }
    if (/\bnext week\b/.test(lower)) {
      due.setDate(due.getDate() + 7);
      due.setHours(10, 0, 0, 0);
      return due;
    }
    due.setDate(due.getDate() + 2);
    due.setHours(10, 0, 0, 0);
    return due;
  }

  function localDateTimeValue(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function buildDraft(contactName, whatMatters, nextStep, profile) {
    const greeting = contactName ? `Hi ${contactName.split(' ')[0]}` : 'Hi';
    const signature = profile.name ? `\n\nBest,\n${profile.name}` : '';
    const contextLine = whatMatters.replace(/^I\s+/i, '').replace(/[.?!]+$/, '');
    const optionalClose = String(profile.followUpStyle || '').toLowerCase().includes('brief')
      ? ''
      : ' I would be happy to continue the conversation if useful.';
    return `${greeting} — great speaking with you. I wanted to follow up while our conversation was still fresh. ${contextLine}. My next step is to ${nextStep.charAt(0).toLowerCase()}${nextStep.slice(1)}.${optionalClose}${signature}`;
  }

  function generateActionCard(rawNote, profile, temporaryContext, now = new Date()) {
    const note = String(rawNote || '').replace(/\s+/g, ' ').trim();
    if (!note) throw new Error('Add a note before creating a next step.');
    const contactName = extractContact(note);
    const companyName = extractCompany(note);
    const whatMatters = importantSentence(note);
    const nextStep = extractAction(note);
    const dueAt = suggestDueDate(note, now);
    const reasonContext = temporaryContext.goals || profile.positioning || profile.services;
    return {
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now.toISOString(),
      rawNote: note,
      contactName,
      companyName,
      whatHappened: compact(note),
      whatMatters,
      nextStep,
      why: reasonContext
        ? `This keeps the conversation connected to your current priority: ${compact(reasonContext, 120)}.`
        : 'This turns the conversation into a specific commitment before the details are forgotten.',
      followUpDraft: buildDraft(contactName, whatMatters, nextStep, profile),
      dueAt: dueAt.toISOString(),
      dueLocal: localDateTimeValue(dueAt),
      priority: /\b(today|urgent|asap|immediately)\b/i.test(note) ? 'Now' : /\bnext month|later\b/i.test(note) ? 'Later' : 'Soon',
      calendarStatus: 'draft',
    };
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function timestamp(date) {
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  }

  function calendarNotes(card) {
    const identity = [card.contactName, card.companyName].filter(Boolean).join(' · ');
    return [
      identity ? `PERSON: ${identity}` : '',
      `WHAT MATTERS: ${card.whatMatters}`,
      `NEXT STEP: ${card.nextStep}`,
      `WHY: ${card.why}`,
      '',
      'FOLLOW-UP DRAFT',
      card.followUpDraft,
      '',
      'ORIGINAL CAPTURE',
      card.rawNote,
    ].filter((line, index, all) => line || (index > 0 && all[index - 1] !== '')).join('\n');
  }

  function buildGoogleCalendarUrl(card) {
    const start = new Date(card.dueAt);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const query = new URLSearchParams({
      action: 'TEMPLATE',
      text: card.nextStep,
      dates: `${timestamp(start)}/${timestamp(end)}`,
      details: calendarNotes(card),
    });
    return `https://calendar.google.com/calendar/render?${query.toString()}`;
  }

  function escapeIcs(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  }

  function buildIcs(card, now = new Date()) {
    const start = new Date(card.dueAt);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//AfterTalk//Conversation to Calendar//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${escapeIcs(`${card.id}@aftertalk.local`)}`,
      `DTSTAMP:${timestamp(now)}`,
      `DTSTART:${timestamp(start)}`,
      `DTEND:${timestamp(end)}`,
      `SUMMARY:${escapeIcs(card.nextStep)}`,
      `DESCRIPTION:${escapeIcs(calendarNotes(card))}`,
      'BEGIN:VALARM',
      'TRIGGER:-PT30M',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcs(card.nextStep)}`,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
  }

  return {
    generateActionCard,
    suggestDueDate,
    localDateTimeValue,
    calendarNotes,
    buildGoogleCalendarUrl,
    buildIcs,
  };
});
