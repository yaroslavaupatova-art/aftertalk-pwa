(() => {
  'use strict';

  const logic = globalThis.AfterTalkLogic;
  const STORAGE = {
    profile: 'aftertalk-web/profile',
    context: 'aftertalk-web/context',
    contextHistory: 'aftertalk-web/context-history',
    calendar: 'aftertalk-web/calendar',
    actions: 'aftertalk-web/actions',
  };
  const SAMPLE_NOTE = 'I spoke with Anna from Northstar. They may need a Nordic market-entry research partner in November. I promised I would send our AI research case on Friday. I should connect with her and suggest a short call next week.';
  const DEFAULT_PROFILE = {
    name: '',
    role: '',
    company: '',
    services: '',
    positioning: '',
    voiceStyle: 'Direct, warm, specific, and practical. Avoid generic AI language.',
    followUpStyle: 'Brief, human, useful, and centered on one clear next step.',
  };
  const DEFAULT_CONTEXT = { label: '', dates: '', goals: '' };
  const DEFAULT_CALENDAR = { provider: 'google' };

  const $ = (id) => document.getElementById(id);
  const read = (key, fallback) => {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));

  let profile = read(STORAGE.profile, DEFAULT_PROFILE);
  let temporaryContext = read(STORAGE.context, DEFAULT_CONTEXT);
  let contextHistory = read(STORAGE.contextHistory, []);
  let calendarPrefs = read(STORAGE.calendar, DEFAULT_CALENDAR);
  let actions = read(STORAGE.actions, []);
  let activeCard = null;
  let recognition = null;
  let listening = false;
  let installPrompt = null;

  function formatDate(value) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(value));
  }

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === `screen-${name}`));
    document.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.screen === name || (name === 'review' && button.dataset.screen === 'capture')));
    if (name === 'recent') renderRecent();
    if (name === 'context') populateContextForm();
    document.querySelector('.main').scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateCalendarDisplay(provider = calendarPrefs.provider) {
    const isApple = provider === 'apple';
    const name = isApple ? 'Apple Calendar' : 'Google Calendar';
    $('calendar-strip-title').textContent = `${name} selected`;
    $('calendar-strip-subtitle').textContent = isApple
      ? 'AfterTalk will prepare a calendar file for your confirmation.'
      : 'AfterTalk will open Google Calendar for your confirmation.';
    $('calendar-setup-status').textContent = isApple
      ? 'Ready via Apple Calendar file. No sign-in is needed; you confirm each task when the file opens.'
      : 'Ready via Google Calendar handoff. Stay signed in to Google; you confirm each task before it is saved.';
  }

  function updateContextStrip() {
    $('avatar-button').textContent = profile.name ? profile.name.slice(0, 2).toUpperCase() : 'ME';
    const hasIdentity = Boolean(profile.name || profile.company || profile.services || profile.positioning);
    $('context-strip-title').textContent = temporaryContext.label || (hasIdentity ? 'Your personal context is active' : 'Set up your personal context');
    $('context-strip-subtitle').textContent = temporaryContext.goals || (hasIdentity
      ? 'Add temporary event or project context only when it helps.'
      : 'Add your name, work, and follow-up style once.');
    updateCalendarDisplay(calendarPrefs.provider);
  }

  function rememberContext(context) {
    if (!(context.label || context.dates || context.goals)) return;
    const key = [context.label, context.dates, context.goals].join('|').toLowerCase();
    const previous = contextHistory.find((item) => item.key === key);
    const snapshot = {
      ...context,
      key,
      id: previous?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      savedAt: new Date().toISOString(),
    };
    contextHistory = [snapshot, ...contextHistory.filter((item) => item.key !== key)].slice(0, 8);
    write(STORAGE.contextHistory, contextHistory);
  }

  function activateSavedContext(item) {
    temporaryContext = { label: item.label || '', dates: item.dates || '', goals: item.goals || '' };
    write(STORAGE.context, temporaryContext);
    populateContextForm();
    updateContextStrip();
    const button = $('save-context');
    button.textContent = 'Context activated ✓';
    setTimeout(() => { button.textContent = 'Save context'; }, 1400);
  }

  function deleteSavedContext(id) {
    contextHistory = contextHistory.filter((item) => item.id !== id);
    write(STORAGE.contextHistory, contextHistory);
    renderContextHistory();
  }

  function renderContextHistory() {
    const list = $('context-history-list');
    list.replaceChildren();
    if (!contextHistory.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = 'No saved contexts yet. Add an event or project above and save it.';
      list.append(empty);
      return;
    }
    contextHistory.forEach((item) => {
      const card = document.createElement('article');
      card.className = 'history-item';
      const title = document.createElement('strong');
      title.textContent = item.label || 'Saved context';
      const dates = document.createElement('small');
      dates.textContent = item.dates || 'No dates';
      const goals = document.createElement('small');
      goals.textContent = item.goals || 'No goals added';
      const actionsRow = document.createElement('div');
      actionsRow.className = 'history-actions';
      const useButton = document.createElement('button');
      useButton.type = 'button';
      useButton.className = 'history-action';
      useButton.textContent = 'Use again';
      useButton.addEventListener('click', () => activateSavedContext(item));
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'history-action delete';
      deleteButton.textContent = 'Delete';
      deleteButton.addEventListener('click', () => deleteSavedContext(item.id));
      actionsRow.append(useButton, deleteButton);
      card.append(title, dates, goals, actionsRow);
      list.append(card);
    });
  }

  function populateContextForm() {
    $('profile-name').value = profile.name || '';
    $('profile-role').value = profile.role || '';
    $('profile-company').value = profile.company || '';
    $('profile-services').value = profile.services || '';
    $('profile-positioning').value = profile.positioning || '';
    $('profile-voice').value = profile.voiceStyle || '';
    $('profile-followup').value = profile.followUpStyle || '';
    $('temp-label').value = temporaryContext.label || '';
    $('temp-dates').value = temporaryContext.dates || '';
    $('temp-goals').value = temporaryContext.goals || '';
    $('profile-calendar').value = calendarPrefs.provider === 'apple' ? 'apple' : 'google';
    updateCalendarDisplay($('profile-calendar').value);
    renderContextHistory();
  }

  function saveContext(event) {
    event.preventDefault();
    profile = {
      name: $('profile-name').value.trim(),
      role: $('profile-role').value.trim(),
      company: $('profile-company').value.trim(),
      services: $('profile-services').value.trim(),
      positioning: $('profile-positioning').value.trim(),
      voiceStyle: $('profile-voice').value.trim(),
      followUpStyle: $('profile-followup').value.trim(),
    };
    temporaryContext = {
      label: $('temp-label').value.trim(),
      dates: $('temp-dates').value.trim(),
      goals: $('temp-goals').value.trim(),
    };
    calendarPrefs = { provider: $('profile-calendar').value === 'apple' ? 'apple' : 'google' };
    rememberContext(temporaryContext);
    write(STORAGE.profile, profile);
    write(STORAGE.context, temporaryContext);
    write(STORAGE.calendar, calendarPrefs);
    updateContextStrip();
    renderContextHistory();
    const button = $('save-context');
    button.textContent = 'Saved ✓';
    setTimeout(() => { button.textContent = 'Save context'; }, 1400);
  }

  function syncReviewToCard() {
    if (!activeCard) return;
    activeCard.whatMatters = $('review-matters').value.trim();
    activeCard.nextStep = $('review-action').value.trim();
    activeCard.followUpDraft = $('review-draft').value.trim();
    const due = new Date($('review-due').value);
    if (!Number.isNaN(due.getTime())) {
      activeCard.dueAt = due.toISOString();
      activeCard.dueLocal = logic.localDateTimeValue(due);
    }
  }

  function renderReview(card) {
    activeCard = card;
    $('review-matters').value = card.whatMatters;
    $('review-action').value = card.nextStep;
    $('review-why').textContent = card.why;
    $('review-draft').value = card.followUpDraft;
    $('review-due').value = card.dueLocal || logic.localDateTimeValue(new Date(card.dueAt));
    $('calendar-choice').value = calendarPrefs.provider === 'apple' ? 'apple' : 'google';
    $('calendar-notice').hidden = true;
    $('calendar-button').disabled = false;
    $('calendar-button').textContent = 'Prepare calendar task';
    showScreen('review');
  }

  function generateAction() {
    try {
      const card = logic.generateActionCard($('raw-note').value, profile, temporaryContext);
      renderReview(card);
    } catch (error) {
      alert(error.message || 'Unable to create the next step.');
    }
  }

  function savePreparedAction(card) {
    const saved = { ...card, calendarStatus: 'prepared', preparedAt: new Date().toISOString() };
    actions = [saved, ...actions.filter((item) => item.id !== saved.id)];
    write(STORAGE.actions, actions);
    activeCard = saved;
  }

  function downloadIcs(card) {
    const blob = new Blob([logic.buildIcs(card)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `aftertalk-${card.id}.ics`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function prepareCalendar() {
    if (!activeCard) return;
    syncReviewToCard();
    const calendar = $('calendar-choice').value;
    const notice = $('calendar-notice');
    calendarPrefs = { provider: calendar };
    write(STORAGE.calendar, calendarPrefs);
    updateContextStrip();

    if (calendar === 'google') {
      const popup = window.open(logic.buildGoogleCalendarUrl(activeCard), '_blank', 'noopener,noreferrer');
      if (!popup) {
        notice.textContent = 'Your browser blocked the Google Calendar window. Allow pop-ups for this site and try again.';
        notice.hidden = false;
        return;
      }
      notice.textContent = 'Google Calendar opened with the full task and draft. Confirm the time and click Save there. Google will use your account’s normal notification settings.';
    } else {
      downloadIcs(activeCard);
      notice.textContent = 'Apple Calendar file created with the full task, draft, and a 30-minute reminder. Open the downloaded file and confirm Add.';
    }

    savePreparedAction(activeCard);
    $('calendar-button').textContent = 'Calendar task prepared ✓';
    $('calendar-button').disabled = true;
    notice.hidden = false;
  }

  function renderRecent() {
    const list = $('recent-list');
    list.replaceChildren();
    if (!actions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-card';
      const icon = document.createElement('div');
      icon.textContent = '✓';
      icon.style.color = '#6D4AFF';
      icon.style.fontSize = '29px';
      const title = document.createElement('strong');
      title.textContent = 'No actions yet';
      const text = document.createElement('p');
      text.textContent = 'Your prepared follow-ups will appear here.';
      empty.append(icon, title, text);
      list.append(empty);
      return;
    }

    actions.forEach((action) => {
      const card = document.createElement('article');
      card.className = 'recent-card';
      const meta = document.createElement('div');
      meta.className = 'recent-meta';
      meta.textContent = `${new Date(action.createdAt).toLocaleDateString()} · ${[action.contactName, action.companyName].filter(Boolean).join(', ') || 'Conversation'}`;
      const title = document.createElement('h2');
      title.textContent = action.nextStep;
      const when = document.createElement('time');
      when.dateTime = action.dueAt;
      when.textContent = formatDate(action.dueAt);
      const status = document.createElement('span');
      status.className = 'status-pill';
      status.textContent = 'Calendar handoff prepared';
      card.append(meta, title, when, status);
      list.append(card);
    });
  }

  function toggleDictation() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Browser voice capture is not available here. Use the microphone on your phone keyboard or type your note.');
      return;
    }
    if (listening && recognition) {
      recognition.stop();
      return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    let finalTranscript = $('raw-note').value.trim();
    recognition.onstart = () => {
      listening = true;
      $('mic-button').classList.add('listening');
      $('mic-button').setAttribute('aria-label', 'Stop voice capture');
      $('mic-hint').textContent = 'Listening… tap when finished';
    };
    recognition.onresult = (event) => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0].transcript;
        if (event.results[index].isFinal) finalTranscript = `${finalTranscript} ${transcript}`.trim();
        else interim += transcript;
      }
      $('raw-note').value = `${finalTranscript}${interim ? ` ${interim}` : ''}`.trim();
      $('generate-button').disabled = !$('raw-note').value.trim();
    };
    recognition.onerror = () => alert('Voice capture stopped. You can continue typing in the same note.');
    recognition.onend = () => {
      listening = false;
      $('mic-button').classList.remove('listening');
      $('mic-button').setAttribute('aria-label', 'Start voice capture');
      $('mic-hint').textContent = 'Tap to speak';
    };
    recognition.start();
  }

  async function installApp() {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      return;
    }
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      alert('To install AfterTalk: open this page in Safari, tap Share, then choose “Add to Home Screen.”');
    } else {
      alert('Open your browser menu and choose “Install app” or “Add to Home Screen.” You can also keep using AfterTalk from this URL.');
    }
  }

  function bindEvents() {
    $('raw-note').addEventListener('input', () => { $('generate-button').disabled = !$('raw-note').value.trim(); });
    $('sample-button').addEventListener('click', () => {
      $('raw-note').value = SAMPLE_NOTE;
      $('generate-button').disabled = false;
    });
    $('generate-button').addEventListener('click', generateAction);
    $('mic-button').addEventListener('click', toggleDictation);
    $('review-back').addEventListener('click', () => showScreen('capture'));
    $('calendar-button').addEventListener('click', prepareCalendar);
    $('context-form').addEventListener('submit', saveContext);
    $('context-strip').addEventListener('click', () => showScreen('context'));
    $('calendar-strip').addEventListener('click', () => showScreen('context'));
    $('avatar-button').addEventListener('click', () => showScreen('context'));
    $('profile-calendar').addEventListener('change', () => updateCalendarDisplay($('profile-calendar').value));
    $('install-button').addEventListener('click', installApp);
    document.querySelectorAll('.nav-button').forEach((button) => button.addEventListener('click', () => showScreen(button.dataset.screen)));

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      installPrompt = event;
    });
  }

  function initialize() {
    bindEvents();
    updateContextStrip();
    populateContextForm();
    renderRecent();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
    if (!('SpeechRecognition' in window) && !('webkitSpeechRecognition' in window)) {
      $('mic-hint').textContent = 'Use keyboard dictation or type below';
    }
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === 'review') {
      $('raw-note').value = SAMPLE_NOTE;
      $('generate-button').disabled = false;
      generateAction();
    }
  }

  initialize();
})();
