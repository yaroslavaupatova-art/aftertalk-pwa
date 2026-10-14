const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TARGET = process.env.TARGET_URL || 'https://yaroslavaupatova-art.github.io/aftertalk-pwa/';
const EXPECTED_SCOPE = new URL('./', TARGET).href;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = '/Users/yaroslava/.hermes/cache/scratch/aftertalk-public-qa-profile';
const ARTIFACTS = '/Users/yaroslava/.hermes/cache/scratch/aftertalk-qa';
const DEBUG_PORT = 9225;

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
let socket;
let nextId = 1;
const pending = new Map();
const checks = [];

function check(name, passed, details = '') {
  checks.push({ name, passed: Boolean(passed), details });
}

async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith(TARGET));
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome debugging target did not become ready.');
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const output = path.join(ARTIFACTS, `${name}.png`);
  fs.writeFileSync(output, Buffer.from(result.data, 'base64'));
  return output;
}

async function waitForApp() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await evaluate("document.readyState === 'complete' && Boolean(globalThis.AfterTalkLogic) && Boolean(document.querySelector('#generate-button'))");
    if (ready) return;
    await sleep(200);
  }
  throw new Error('AfterTalk did not initialize.');
}

async function main() {
  browser = spawn(CHROME, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    '--window-size=390,844',
    `--user-data-dir=${PROFILE}`,
    `${TARGET}?qa=${Date.now()}`,
  ], { stdio: 'ignore' });

  const target = await waitForTarget();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await waitForApp();
  await sleep(700);

  const initial = await evaluate(`({
    title: document.title,
    active: document.querySelector('.screen.active')?.id,
    setup: document.querySelector('#context-strip-title')?.textContent,
    calendar: document.querySelector('#calendar-strip-title')?.textContent,
    generateDisabled: document.querySelector('#generate-button')?.disabled,
    nav: [...document.querySelectorAll('.nav-button')].map((item) => item.textContent.trim()),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    navRect: (() => { const r = document.querySelector('.bottom-nav').getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight}; })(),
    manifest: document.querySelector('link[rel=manifest]')?.href,
    resources: performance.getEntriesByType('resource').map((item) => item.name)
  })`);
  check('Page title', initial.title === 'AfterTalk', initial.title);
  check('Initial capture screen', initial.active === 'screen-capture', initial.active);
  check('Blank-profile onboarding prompt', initial.setup === 'Set up your personal context', initial.setup);
  check('Calendar shown before capture', initial.calendar === 'Google Calendar selected', initial.calendar);
  check('Generate disabled without a note', initial.generateDisabled === true);
  check('Three navigation destinations', JSON.stringify(initial.nav) === JSON.stringify(['◉Capture', '✓Recent', '◎Context']), JSON.stringify(initial.nav));
  check('No initial horizontal overflow', !initial.horizontalOverflow);
  check('Bottom navigation visible initially', initial.navRect.bottom <= initial.navRect.viewport + 1, JSON.stringify(initial.navRect));
  check('Manifest is scoped to the published path', initial.manifest === new URL('manifest.webmanifest', TARGET).href, initial.manifest);
  check('No third-party runtime assets', initial.resources.every((url) => new URL(url).origin === new URL(TARGET).origin), JSON.stringify(initial.resources));
  const captureShot = await screenshot('01-capture');
  await evaluate("document.querySelector('.main').scrollTop = document.querySelector('.main').scrollHeight");
  await sleep(100);
  const captureBottom = await evaluate(`(() => {
    const main = document.querySelector('.main').getBoundingClientRect();
    const button = document.querySelector('#generate-button').getBoundingClientRect();
    return {visible:button.top >= main.top && button.bottom <= main.bottom,main:{top:main.top,bottom:main.bottom},button:{top:button.top,bottom:button.bottom}};
  })()`);
  check('Capture action reachable by scrolling', captureBottom.visible, JSON.stringify(captureBottom));
  const captureBottomShot = await screenshot('01b-capture-bottom');

  const pwa = await evaluate(`Promise.all([
    fetch('manifest.webmanifest').then(r => ({ok:r.ok,status:r.status,type:r.headers.get('content-type')})),
    fetch('privacy.html').then(r => ({ok:r.ok,status:r.status})),
    fetch('terms.html').then(r => ({ok:r.ok,status:r.status})),
    fetch('app.js').then(r => r.text()).then(text => ({privateDefaults: /Yaroslava|Agentic Systems/.test(text)})),
    navigator.serviceWorker.ready.then(reg => ({scope:reg.scope,state:reg.active?.state}))
  ]).then(([manifest,privacy,terms,source,worker]) => ({manifest,privacy,terms,source,worker}))`);
  check('Manifest served correctly', pwa.manifest.ok && pwa.manifest.type.includes('application/manifest+json'), JSON.stringify(pwa.manifest));
  check('Privacy notice available', pwa.privacy.ok, JSON.stringify(pwa.privacy));
  check('Pilot terms available', pwa.terms.ok, JSON.stringify(pwa.terms));
  check('Public defaults contain no private profile', !pwa.source.privateDefaults);
  check('Service worker active', pwa.worker.state === 'activated', JSON.stringify(pwa.worker));
  check('Service worker scope correct', pwa.worker.scope === EXPECTED_SCOPE, pwa.worker.scope);

  await evaluate("document.querySelector('[data-screen=context]').click()");
  await sleep(200);
  const contextLayout = await evaluate(`({
    active: document.querySelector('.screen.active')?.id,
    navRect: (() => { const r = document.querySelector('.bottom-nav').getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight}; })(),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    emptyHistory: document.querySelector('.history-empty')?.textContent
  })`);
  check('Context screen opens', contextLayout.active === 'screen-context', contextLayout.active);
  check('Context empty state shown', contextLayout.emptyHistory?.startsWith('No saved contexts yet'), contextLayout.emptyHistory);
  check('Context has no horizontal overflow', !contextLayout.horizontalOverflow);
  check('Bottom navigation visible on long context screen', contextLayout.navRect.bottom <= contextLayout.navRect.viewport + 1, JSON.stringify(contextLayout.navRect));

  await evaluate(`(() => {
    document.querySelector('#profile-name').value = 'QA Tester';
    document.querySelector('#profile-role').value = 'Marketing Manager';
    document.querySelector('#profile-company').value = 'Test Company';
    document.querySelector('#profile-services').value = 'Business growth and marketing operations';
    document.querySelector('#profile-positioning').value = 'Turn conversations into useful follow-up';
    document.querySelector('#profile-calendar').value = 'apple';
    document.querySelector('#profile-calendar').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#temp-label').value = 'Growth Summit';
    document.querySelector('#temp-dates').value = '20–21 October';
    document.querySelector('#temp-goals').value = 'Partnership conversations';
    document.querySelector('#context-form').requestSubmit();
  })()`);
  await sleep(200);
  const firstSave = await evaluate(`({
    historyCount: document.querySelectorAll('.history-item').length,
    historyTitle: document.querySelector('.history-item strong')?.textContent,
    calendarStatus: document.querySelector('#calendar-setup-status')?.textContent,
    calendarStored: JSON.parse(localStorage.getItem('aftertalk-web/calendar'))?.provider,
    profileStored: JSON.parse(localStorage.getItem('aftertalk-web/profile'))?.name
  })`);
  check('Profile persists locally', firstSave.profileStored === 'QA Tester', firstSave.profileStored);
  check('Preferred calendar persists before capture', firstSave.calendarStored === 'apple', firstSave.calendarStored);
  check('First temporary context enters history', firstSave.historyCount === 1 && firstSave.historyTitle === 'Growth Summit', JSON.stringify(firstSave));
  check('Apple handoff explained honestly', firstSave.calendarStatus.toLowerCase().includes('calendar file') && firstSave.calendarStatus.toLowerCase().includes('confirm'), firstSave.calendarStatus);

  await evaluate(`(() => {
    document.querySelector('#temp-label').value = 'Board Week';
    document.querySelector('#temp-dates').value = '3–5 November';
    document.querySelector('#temp-goals').value = 'Capture strategic ideas';
    document.querySelector('#context-form').requestSubmit();
  })()`);
  await sleep(150);
  let history = await evaluate(`({count:document.querySelectorAll('.history-item').length,titles:[...document.querySelectorAll('.history-item strong')].map(x=>x.textContent)})`);
  check('Second context is added newest-first', history.count === 2 && history.titles[0] === 'Board Week' && history.titles[1] === 'Growth Summit', JSON.stringify(history));

  await evaluate("document.querySelectorAll('.history-item')[1].querySelector('.history-action').click()");
  await sleep(100);
  const activated = await evaluate(`({label:document.querySelector('#temp-label').value,strip:document.querySelector('#context-strip-title').textContent,stored:JSON.parse(localStorage.getItem('aftertalk-web/context')).label})`);
  check('Saved context can be reactivated', activated.label === 'Growth Summit' && activated.strip === 'Growth Summit' && activated.stored === 'Growth Summit', JSON.stringify(activated));
  await sleep(1500);

  await evaluate("document.querySelectorAll('.history-item')[0].querySelector('.history-action.delete').click()");
  await sleep(100);
  history = await evaluate(`({count:document.querySelectorAll('.history-item').length,title:document.querySelector('.history-item strong')?.textContent})`);
  check('Saved context can be deleted', history.count === 1 && history.title === 'Growth Summit', JSON.stringify(history));
  const contextShot = await screenshot('02-context');
  await evaluate("document.querySelector('.main').scrollTop = document.querySelector('.main').scrollHeight");
  await sleep(100);
  const contextBottom = await evaluate(`(() => {
    const main = document.querySelector('.main').getBoundingClientRect();
    const button = document.querySelector('#save-context').getBoundingClientRect();
    return {visible:button.top >= main.top && button.bottom <= main.bottom,main:{top:main.top,bottom:main.bottom},button:{top:button.top,bottom:button.bottom}};
  })()`);
  check('Context save and history controls reachable by scrolling', contextBottom.visible, JSON.stringify(contextBottom));
  const contextBottomShot = await screenshot('02b-context-bottom');

  await evaluate("document.querySelector('[data-screen=capture]').click(); document.querySelector('#sample-button').click(); document.querySelector('#generate-button').click();");
  await sleep(180);
  const review = await evaluate(`({
    active: document.querySelector('.screen.active')?.id,
    matters: document.querySelector('#review-matters').value,
    action: document.querySelector('#review-action').value,
    draft: document.querySelector('#review-draft').value,
    due: document.querySelector('#review-due').value,
    calendar: document.querySelector('#calendar-choice').value,
    navRect: (() => { const r = document.querySelector('.bottom-nav').getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight}; })(),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  })`);
  check('Review screen generated', review.active === 'screen-review' && review.action.length > 0 && review.matters.length > 0, JSON.stringify(review));
  check('Follow-up draft uses saved profile', review.draft.includes('QA Tester') && !review.draft.includes('Your name'));
  check('Due date generated', !Number.isNaN(new Date(review.due).getTime()), review.due);
  check('Preferred calendar preselected', review.calendar === 'apple', review.calendar);
  check('Review has no horizontal overflow', !review.horizontalOverflow);
  check('Bottom navigation visible on long review screen', review.navRect.bottom <= review.navRect.viewport + 1, JSON.stringify(review.navRect));
  const reviewShot = await screenshot('03-review');
  await evaluate("document.querySelector('.main').scrollTop = document.querySelector('.main').scrollHeight");
  await sleep(100);
  const reviewBottom = await evaluate(`(() => {
    const main = document.querySelector('.main').getBoundingClientRect();
    const button = document.querySelector('#calendar-button').getBoundingClientRect();
    const date = document.querySelector('#review-due').getBoundingClientRect();
    return {visible:button.top >= main.top && button.bottom <= main.bottom && date.top >= main.top && date.bottom <= main.bottom,main:{top:main.top,bottom:main.bottom},button:{top:button.top,bottom:button.bottom},date:{top:date.top,bottom:date.bottom}};
  })()`);
  check('Calendar controls reachable by scrolling', reviewBottom.visible, JSON.stringify(reviewBottom));
  const reviewBottomShot = await screenshot('03b-review-bottom');

  await evaluate("document.querySelector('#calendar-button').click()");
  await sleep(200);
  const prepared = await evaluate(`({
    notice: document.querySelector('#calendar-notice').textContent,
    noticeHidden: document.querySelector('#calendar-notice').hidden,
    buttonDisabled: document.querySelector('#calendar-button').disabled,
    actionCount: JSON.parse(localStorage.getItem('aftertalk-web/actions') || '[]').length
  })`);
  check('Apple calendar handoff reaches confirmation state', !prepared.noticeHidden && prepared.notice.includes('Apple Calendar file created'), JSON.stringify(prepared));
  check('Prepared action saved locally', prepared.buttonDisabled && prepared.actionCount === 1, JSON.stringify(prepared));

  await evaluate("document.querySelector('[data-screen=recent]').click()");
  await sleep(100);
  const recent = await evaluate(`({count:document.querySelectorAll('.recent-card').length,title:document.querySelector('.recent-card h2')?.textContent,status:document.querySelector('.status-pill')?.textContent})`);
  check('Prepared action appears in Recent', recent.count === 1 && recent.title?.length > 0 && recent.status === 'Calendar handoff prepared', JSON.stringify(recent));

  await send('Page.reload', { ignoreCache: true });
  await waitForApp();
  await sleep(700);
  const persisted = await evaluate(`({
    context: document.querySelector('#context-strip-title').textContent,
    calendar: document.querySelector('#calendar-strip-title').textContent,
    historyCount: JSON.parse(localStorage.getItem('aftertalk-web/context-history') || '[]').length,
    actionCount: JSON.parse(localStorage.getItem('aftertalk-web/actions') || '[]').length,
    profile: JSON.parse(localStorage.getItem('aftertalk-web/profile') || '{}').name
  })`);
  check('Data survives reload on the same device', persisted.context === 'Growth Summit' && persisted.calendar === 'Apple Calendar selected' && persisted.historyCount === 1 && persisted.actionCount === 1 && persisted.profile === 'QA Tester', JSON.stringify(persisted));

  const failures = checks.filter((item) => !item.passed);
  const report = {
    status: failures.length ? 'failed' : 'passed',
    target: TARGET,
    viewport: '390x844',
    total: checks.length,
    passed: checks.length - failures.length,
    failed: failures.length,
    failures,
    checks,
    screenshots: [captureShot, captureBottomShot, contextShot, contextBottomShot, reviewShot, reviewBottomShot],
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (socket) socket.close();
  if (browser) browser.kill('SIGTERM');
});
